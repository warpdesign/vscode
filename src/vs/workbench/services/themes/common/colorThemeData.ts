/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'vs/base/common/path';
import * as Json from 'vs/base/common/json';
import { Color } from 'vs/base/common/color';
import { ExtensionData, ITokenColorCustomizations, ITextMateThemingRule, IColorTheme, IColorMap, IThemeExtensionPoint, VS_LIGHT_THEME, VS_HC_THEME, IColorCustomizations, IExperimentalTokenStyleCustomizations, ITokenColorizationSetting } from 'vs/workbench/services/themes/common/workbenchThemeService';
import { convertSettings } from 'vs/workbench/services/themes/common/themeCompatibility';
import * as nls from 'vs/nls';
import * as types from 'vs/base/common/types';
import * as objects from 'vs/base/common/objects';
import * as resources from 'vs/base/common/resources';
import { Extensions as ColorRegistryExtensions, IColorRegistry, ColorIdentifier, editorBackground, editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { ThemeType } from 'vs/platform/theme/common/themeService';
import { Registry } from 'vs/platform/registry/common/platform';
import { getParseErrorMessage } from 'vs/base/common/jsonErrorMessages';
import { URI } from 'vs/base/common/uri';
import { parse as parsePList } from 'vs/workbench/services/themes/common/plistParser';
import { startsWith } from 'vs/base/common/strings';
import { TokenStyle, TokenClassification, ProbeScope, TokenStylingRule, getTokenClassificationRegistry, TokenStyleValue, matchTokenStylingRule } from 'vs/platform/theme/common/tokenClassificationRegistry';
import { MatcherWithPriority, Matcher, createMatchers } from 'vs/workbench/services/themes/common/textMateScopeMatcher';
import { IExtensionResourceLoaderService } from 'vs/workbench/services/extensionResourceLoader/common/extensionResourceLoader';
import { FontStyle, ColorId, MetadataConsts } from 'vs/editor/common/modes';

let colorRegistry = Registry.as<IColorRegistry>(ColorRegistryExtensions.ColorContribution);

let tokenClassificationRegistry = getTokenClassificationRegistry();

const tokenGroupToScopesMap = {
	comments: ['comment', 'punctuation.definition.comment'],
	strings: ['string', 'meta.embedded.assembly'],
	keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
	numbers: ['constant.numeric'],
	types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
	functions: ['entity.name.function', 'support.function'],
	variables: ['variable', 'entity.name.variable']
};


export class ColorThemeData implements IColorTheme {

	id: string;
	label: string;
	settingsId: string;
	description?: string;
	isLoaded: boolean;
	location?: URI;
	watch?: boolean;
	extensionData?: ExtensionData;

	private themeTokenColors: ITextMateThemingRule[] = [];
	private customTokenColors: ITextMateThemingRule[] = [];
	private colorMap: IColorMap = {};
	private customColorMap: IColorMap = {};

	private tokenStylingRules: TokenStylingRule[] | undefined = undefined; // undefined if the theme has no tokenStylingRules section
	private customTokenStylingRules: TokenStylingRule[] = [];

	private themeTokenScopeMatchers: Matcher<ProbeScope>[] | undefined;
	private customTokenScopeMatchers: Matcher<ProbeScope>[] | undefined;

	private textMateThemingRules: ITextMateThemingRule[] | undefined = undefined; // created on demand
	private tokenColorIndex: TokenColorIndex | undefined = undefined; // created on demand

	private constructor(id: string, label: string, settingsId: string) {
		this.id = id;
		this.label = label;
		this.settingsId = settingsId;
		this.isLoaded = false;
	}

	get tokenColors(): ITextMateThemingRule[] {
		if (!this.textMateThemingRules) {
			const result: ITextMateThemingRule[] = [];

			// the default rule (scope empty) is always the first rule. Ignore all other default rules.
			const foreground = this.getColor(editorForeground) || this.getDefault(editorForeground)!;
			const background = this.getColor(editorBackground) || this.getDefault(editorBackground)!;
			result.push({
				settings: {
					foreground: Color.Format.CSS.formatHexA(foreground, true),
					background: Color.Format.CSS.formatHexA(background, true)
				}
			});

			let hasDefaultTokens = false;

			function addRule(rule: ITextMateThemingRule) {
				if (rule.scope && rule.settings) {
					if (rule.scope === 'token.info-token') {
						hasDefaultTokens = true;
					}
					result.push(rule);
				}
			}

			this.themeTokenColors.forEach(addRule);
			// Add the custom colors after the theme colors
			// so that they will override them
			this.customTokenColors.forEach(addRule);

			if (!hasDefaultTokens) {
				defaultThemeColors[this.type].forEach(addRule);
			}
			this.textMateThemingRules = result;
		}
		return this.textMateThemingRules;
	}

	public getColor(colorId: ColorIdentifier, useDefault?: boolean): Color | undefined {
		let color: Color | undefined = this.customColorMap[colorId];
		if (color) {
			return color;
		}
		color = this.colorMap[colorId];
		if (useDefault !== false && types.isUndefined(color)) {
			color = this.getDefault(colorId);
		}
		return color;
	}

	public getTokenStyle(classification: TokenClassification, useDefault?: boolean): TokenStyle | undefined {
		let result: any = {
			foreground: undefined,
			bold: undefined,
			underline: undefined,
			italic: undefined
		};
		let score = {
			foreground: -1,
			bold: -1,
			underline: -1,
			italic: -1
		};

		function _processStyle(matchScore: number, style: TokenStyle) {
			if (style.foreground && score.foreground <= matchScore) {
				score.foreground = matchScore;
				result.foreground = style.foreground;
			}
			for (let p of ['bold', 'underline', 'italic']) {
				const property = p as keyof TokenStyle;
				const info = style[property];
				if (info !== undefined) {
					if (score[property] <= matchScore) {
						score[property] = matchScore;
						result[property] = info;
					}
				}
			}
		}
		if (this.tokenStylingRules === undefined) {
			for (const rule of tokenClassificationRegistry.getTokenStylingDefaultRules()) {
				const matchScore = matchTokenStylingRule(rule, classification);
				if (matchScore >= 0) {
					let style: TokenStyle | undefined;
					if (rule.defaults.scopesToProbe) {
						style = this.resolveScopes(rule.defaults.scopesToProbe);
					}
					if (!style && useDefault !== false) {
						style = this.resolveTokenStyleValue(rule.defaults[this.type]);
					}
					if (style) {
						_processStyle(matchScore, style);
					}
				}
			}
		} else {
			for (const rule of this.tokenStylingRules) {
				const matchScore = matchTokenStylingRule(rule, classification);
				if (matchScore >= 0) {
					_processStyle(matchScore, rule.value);
				}
			}
		}
		for (const rule of this.customTokenStylingRules) {
			const matchScore = matchTokenStylingRule(rule, classification);
			if (matchScore >= 0) {
				_processStyle(matchScore, rule.value);
			}
		}
		return TokenStyle.fromData(result);

	}

	/**
	 * @param tokenStyleValue Resolve a tokenStyleValue in the context of a theme
	 */
	private resolveTokenStyleValue(tokenStyleValue: TokenStyleValue | undefined): TokenStyle | undefined {
		if (tokenStyleValue === undefined) {
			return undefined;
		} else if (typeof tokenStyleValue === 'string') {
			const [type, ...modifiers] = tokenStyleValue.split('.');
			const classification = tokenClassificationRegistry.getTokenClassification(type, modifiers);
			if (classification) {
				return this.getTokenStyle(classification);
			}
		} else if (typeof tokenStyleValue === 'object') {
			return tokenStyleValue;
		}
		return undefined;
	}

	private getTokenColorIndex(): TokenColorIndex {
		// collect all colors that tokens can have
		if (!this.tokenColorIndex) {
			const index = new TokenColorIndex();
			this.tokenColors.forEach(rule => {
				index.add(rule.settings.foreground);
				index.add(rule.settings.background);
			});

			if (this.tokenStylingRules) {
				this.tokenStylingRules.forEach(r => index.add(r.value.foreground));
			} else {
				tokenClassificationRegistry.getTokenStylingDefaultRules().forEach(r => {
					const defaultColor = r.defaults[this.type];
					if (defaultColor && typeof defaultColor === 'object') {
						index.add(defaultColor.foreground);
					}
				});
			}
			this.customTokenStylingRules.forEach(r => index.add(r.value.foreground));

			this.tokenColorIndex = index;
		}
		return this.tokenColorIndex;
	}

	public get tokenColorMap(): string[] {
		return this.getTokenColorIndex().asArray();
	}

	public getTokenStyleMetadata(type: string, modifiers: string[], useDefault?: boolean): number | undefined {
		const classification = tokenClassificationRegistry.getTokenClassification(type, modifiers);
		if (!classification) {
			return undefined;
		}
		const style = this.getTokenStyle(classification, useDefault);
		let fontStyle = FontStyle.None;
		let foreground = 0;
		if (style) {
			if (style.bold) {
				fontStyle |= FontStyle.Bold;
			}
			if (style.underline) {
				fontStyle |= FontStyle.Underline;
			}
			if (style.italic) {
				fontStyle |= FontStyle.Italic;
			}
			foreground = this.getTokenColorIndex().get(style.foreground);
		}
		return toMetadata(fontStyle, foreground, 0);
	}

	public getDefault(colorId: ColorIdentifier): Color | undefined {
		return colorRegistry.resolveDefaultColor(colorId, this);
	}

	public resolveScopes(scopes: ProbeScope[]): TokenStyle | undefined {

		if (!this.themeTokenScopeMatchers) {
			this.themeTokenScopeMatchers = this.themeTokenColors.map(getScopeMatcher);
		}
		if (!this.customTokenScopeMatchers) {
			this.customTokenScopeMatchers = this.customTokenColors.map(getScopeMatcher);
		}

		for (let scope of scopes) {
			let foreground: string | undefined = undefined;
			let fontStyle: string | undefined = undefined;
			let foregroundScore = -1;
			let fontStyleScore = -1;

			function findTokenStyleForScopeInScopes(scopeMatchers: Matcher<ProbeScope>[], tokenColors: ITextMateThemingRule[]) {
				for (let i = 0; i < scopeMatchers.length; i++) {
					const score = scopeMatchers[i](scope);
					if (score >= 0) {
						const settings = tokenColors[i].settings;
						if (score >= foregroundScore && settings.foreground) {
							foreground = settings.foreground;
						}
						if (score >= fontStyleScore && types.isString(settings.fontStyle)) {
							fontStyle = settings.fontStyle;
						}
					}
				}
			}
			findTokenStyleForScopeInScopes(this.themeTokenScopeMatchers, this.themeTokenColors);
			findTokenStyleForScopeInScopes(this.customTokenScopeMatchers, this.customTokenColors);
			if (foreground !== undefined || fontStyle !== undefined) {
				return TokenStyle.fromSettings(foreground, fontStyle);
			}
		}
		return undefined;
	}

	public defines(colorId: ColorIdentifier): boolean {
		return this.customColorMap.hasOwnProperty(colorId) || this.colorMap.hasOwnProperty(colorId);
	}

	public setCustomColors(colors: IColorCustomizations) {
		this.customColorMap = {};
		this.overwriteCustomColors(colors);

		const themeSpecificColors = colors[`[${this.settingsId}]`] as IColorCustomizations;
		if (types.isObject(themeSpecificColors)) {
			this.overwriteCustomColors(themeSpecificColors);
		}

		this.tokenColorIndex = undefined;
		this.textMateThemingRules = undefined;
		this.customTokenScopeMatchers = undefined;
	}

	private overwriteCustomColors(colors: IColorCustomizations) {
		for (let id in colors) {
			let colorVal = colors[id];
			if (typeof colorVal === 'string') {
				this.customColorMap[id] = Color.fromHex(colorVal);
			}
		}
	}

	public setCustomTokenColors(customTokenColors: ITokenColorCustomizations) {
		this.customTokenColors = [];

		// first add the non-theme specific settings
		this.addCustomTokenColors(customTokenColors);

		// append theme specific settings. Last rules will win.
		const themeSpecificTokenColors = customTokenColors[`[${this.settingsId}]`] as ITokenColorCustomizations;
		if (types.isObject(themeSpecificTokenColors)) {
			this.addCustomTokenColors(themeSpecificTokenColors);
		}

		this.tokenColorIndex = undefined;
		this.textMateThemingRules = undefined;
		this.customTokenScopeMatchers = undefined;
	}

	public setCustomTokenStyleRules(tokenStylingRules: IExperimentalTokenStyleCustomizations) {
		this.customTokenStylingRules = [];
		readCustomTokenStyleRules(tokenStylingRules, this.customTokenStylingRules);

		const themeSpecificColors = tokenStylingRules[`[${this.settingsId}]`] as IExperimentalTokenStyleCustomizations;
		if (types.isObject(themeSpecificColors)) {
			readCustomTokenStyleRules(themeSpecificColors, this.customTokenStylingRules);
		}

		this.tokenColorIndex = undefined;
		this.textMateThemingRules = undefined;
	}

	private addCustomTokenColors(customTokenColors: ITokenColorCustomizations) {
		// Put the general customizations such as comments, strings, etc. first so that
		// they can be overridden by specific customizations like "string.interpolated"
		for (let tokenGroup in tokenGroupToScopesMap) {
			const group = <keyof typeof tokenGroupToScopesMap>tokenGroup; // TS doesn't type 'tokenGroup' properly
			let value = customTokenColors[group];
			if (value) {
				let settings = typeof value === 'string' ? { foreground: value } : value;
				let scopes = tokenGroupToScopesMap[group];
				for (let scope of scopes) {
					this.customTokenColors.push({ scope, settings });
				}
			}
		}

		// specific customizations
		if (Array.isArray(customTokenColors.textMateRules)) {
			for (let rule of customTokenColors.textMateRules) {
				if (rule.scope && rule.settings) {
					this.customTokenColors.push(rule);
				}
			}
		}
	}

	public ensureLoaded(extensionResourceLoaderService: IExtensionResourceLoaderService): Promise<void> {
		return !this.isLoaded ? this.load(extensionResourceLoaderService) : Promise.resolve(undefined);
	}

	public reload(extensionResourceLoaderService: IExtensionResourceLoaderService): Promise<void> {
		return this.load(extensionResourceLoaderService);
	}

	private load(extensionResourceLoaderService: IExtensionResourceLoaderService): Promise<void> {
		if (!this.location) {
			return Promise.resolve(undefined);
		}
		this.themeTokenColors = [];
		this.clearCaches();

		const result = {
			colors: {},
			textMateRules: [],
			stylingRules: undefined
		};
		return _loadColorTheme(extensionResourceLoaderService, this.location, result).then(_ => {
			this.isLoaded = true;
			this.tokenStylingRules = result.stylingRules;
			this.colorMap = result.colors;
			this.themeTokenColors = result.textMateRules;
		});
	}

	public clearCaches() {
		this.tokenColorIndex = undefined;
		this.textMateThemingRules = undefined;
		this.themeTokenScopeMatchers = undefined;
		this.customTokenScopeMatchers = undefined;
	}

	toStorageData() {
		let colorMapData: { [key: string]: string } = {};
		for (let key in this.colorMap) {
			colorMapData[key] = Color.Format.CSS.formatHexA(this.colorMap[key], true);
		}
		// no need to persist custom colors, they will be taken from the settings
		return JSON.stringify({
			id: this.id,
			label: this.label,
			settingsId: this.settingsId,
			selector: this.id.split(' ').join('.'), // to not break old clients
			themeTokenColors: this.themeTokenColors,
			extensionData: this.extensionData,
			colorMap: colorMapData,
			watch: this.watch
		});
	}

	hasEqualData(other: ColorThemeData) {
		return objects.equals(this.colorMap, other.colorMap) && objects.equals(this.themeTokenColors, other.themeTokenColors);
	}

	get baseTheme(): string {
		return this.id.split(' ')[0];
	}

	get type(): ThemeType {
		switch (this.baseTheme) {
			case VS_LIGHT_THEME: return 'light';
			case VS_HC_THEME: return 'hc';
			default: return 'dark';
		}
	}

	// constructors

	static createUnloadedTheme(id: string): ColorThemeData {
		let themeData = new ColorThemeData(id, '', '__' + id);
		themeData.isLoaded = false;
		themeData.themeTokenColors = [];
		themeData.watch = false;
		return themeData;
	}

	static createLoadedEmptyTheme(id: string, settingsId: string): ColorThemeData {
		let themeData = new ColorThemeData(id, '', settingsId);
		themeData.isLoaded = true;
		themeData.themeTokenColors = [];
		themeData.watch = false;
		return themeData;
	}

	static fromStorageData(input: string): ColorThemeData | undefined {
		try {
			let data = JSON.parse(input);
			let theme = new ColorThemeData('', '', '');
			for (let key in data) {
				switch (key) {
					case 'colorMap':
						let colorMapData = data[key];
						for (let id in colorMapData) {
							theme.colorMap[id] = Color.fromHex(colorMapData[id]);
						}
						break;
					case 'themeTokenColors':
					case 'id': case 'label': case 'settingsId': case 'extensionData': case 'watch':
						(theme as any)[key] = data[key];
						break;
				}
			}
			if (!theme.id || !theme.settingsId) {
				return undefined;
			}
			return theme;
		} catch (e) {
			return undefined;
		}
	}

	static fromExtensionTheme(theme: IThemeExtensionPoint, colorThemeLocation: URI, extensionData: ExtensionData): ColorThemeData {
		const baseTheme: string = theme['uiTheme'] || 'vs-dark';
		const themeSelector = toCSSSelector(extensionData.extensionId, theme.path);
		const id = `${baseTheme} ${themeSelector}`;
		const label = theme.label || basename(theme.path);
		const settingsId = theme.id || label;
		const themeData = new ColorThemeData(id, label, settingsId);
		themeData.description = theme.description;
		themeData.watch = theme._watch === true;
		themeData.location = colorThemeLocation;
		themeData.extensionData = extensionData;
		themeData.isLoaded = false;
		return themeData;
	}
}

function toCSSSelector(extensionId: string, path: string) {
	if (startsWith(path, './')) {
		path = path.substr(2);
	}
	let str = `${extensionId}-${path}`;

	//remove all characters that are not allowed in css
	str = str.replace(/[^_\-a-zA-Z0-9]/g, '-');
	if (str.charAt(0).match(/[0-9\-]/)) {
		str = '_' + str;
	}
	return str;
}

function _loadColorTheme(extensionResourceLoaderService: IExtensionResourceLoaderService, themeLocation: URI, result: { textMateRules: ITextMateThemingRule[], colors: IColorMap, stylingRules: TokenStylingRule[] | undefined }): Promise<any> {
	if (resources.extname(themeLocation) === '.json') {
		return extensionResourceLoaderService.readExtensionResource(themeLocation).then(content => {
			let errors: Json.ParseError[] = [];
			let contentValue = Json.parse(content, errors);
			if (errors.length > 0) {
				return Promise.reject(new Error(nls.localize('error.cannotparsejson', "Problems parsing JSON theme file: {0}", errors.map(e => getParseErrorMessage(e.error)).join(', '))));
			} else if (Json.getNodeType(contentValue) !== 'object') {
				return Promise.reject(new Error(nls.localize('error.invalidformat', "Invalid format for JSON theme file: Object expected.")));
			}
			let includeCompletes: Promise<any> = Promise.resolve(null);
			if (contentValue.include) {
				includeCompletes = _loadColorTheme(extensionResourceLoaderService, resources.joinPath(resources.dirname(themeLocation), contentValue.include), result);
			}
			return includeCompletes.then(_ => {
				if (Array.isArray(contentValue.settings)) {
					convertSettings(contentValue.settings, result);
					return null;
				}
				let colors = contentValue.colors;
				if (colors) {
					if (typeof colors !== 'object') {
						return Promise.reject(new Error(nls.localize({ key: 'error.invalidformat.colors', comment: ['{0} will be replaced by a path. Values in quotes should not be translated.'] }, "Problem parsing color theme file: {0}. Property 'colors' is not of type 'object'.", themeLocation.toString())));
					}
					// new JSON color themes format
					for (let colorId in colors) {
						let colorHex = colors[colorId];
						if (typeof colorHex === 'string') { // ignore colors tht are null
							result.colors[colorId] = Color.fromHex(colors[colorId]);
						}
					}
				}
				let tokenColors = contentValue.tokenColors;
				if (tokenColors) {
					if (Array.isArray(tokenColors)) {
						result.textMateRules.push(...tokenColors);
						return null;
					} else if (typeof tokenColors === 'string') {
						return _loadSyntaxTokens(extensionResourceLoaderService, resources.joinPath(resources.dirname(themeLocation), tokenColors), result);
					} else {
						return Promise.reject(new Error(nls.localize({ key: 'error.invalidformat.tokenColors', comment: ['{0} will be replaced by a path. Values in quotes should not be translated.'] }, "Problem parsing color theme file: {0}. Property 'tokenColors' should be either an array specifying colors or a path to a TextMate theme file", themeLocation.toString())));
					}
				}
				let tokenStylingRules = contentValue.tokenStylingRules;
				if (tokenStylingRules && typeof tokenStylingRules === 'object') {
					result.stylingRules = readCustomTokenStyleRules(tokenStylingRules, result.stylingRules);
				}
				return null;
			});
		});
	} else {
		return _loadSyntaxTokens(extensionResourceLoaderService, themeLocation, result);
	}
}

function _loadSyntaxTokens(extensionResourceLoaderService: IExtensionResourceLoaderService, themeLocation: URI, result: { textMateRules: ITextMateThemingRule[], colors: IColorMap }): Promise<any> {
	return extensionResourceLoaderService.readExtensionResource(themeLocation).then(content => {
		try {
			let contentValue = parsePList(content);
			let settings: ITextMateThemingRule[] = contentValue.settings;
			if (!Array.isArray(settings)) {
				return Promise.reject(new Error(nls.localize('error.plist.invalidformat', "Problem parsing tmTheme file: {0}. 'settings' is not array.")));
			}
			convertSettings(settings, result);
			return Promise.resolve(null);
		} catch (e) {
			return Promise.reject(new Error(nls.localize('error.cannotparse', "Problems parsing tmTheme file: {0}", e.message)));
		}
	}, error => {
		return Promise.reject(new Error(nls.localize('error.cannotload', "Problems loading tmTheme file {0}: {1}", themeLocation.toString(), error.message)));
	});
}

let defaultThemeColors: { [baseTheme: string]: ITextMateThemingRule[] } = {
	'light': [
		{ scope: 'token.info-token', settings: { foreground: '#316bcd' } },
		{ scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
		{ scope: 'token.error-token', settings: { foreground: '#cd3131' } },
		{ scope: 'token.debug-token', settings: { foreground: '#800080' } }
	],
	'dark': [
		{ scope: 'token.info-token', settings: { foreground: '#6796e6' } },
		{ scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
		{ scope: 'token.error-token', settings: { foreground: '#f44747' } },
		{ scope: 'token.debug-token', settings: { foreground: '#b267e6' } }
	],
	'hc': [
		{ scope: 'token.info-token', settings: { foreground: '#6796e6' } },
		{ scope: 'token.warn-token', settings: { foreground: '#008000' } },
		{ scope: 'token.error-token', settings: { foreground: '#FF0000' } },
		{ scope: 'token.debug-token', settings: { foreground: '#b267e6' } }
	],
};

const noMatch = (_scope: ProbeScope) => -1;

function nameMatcher(identifers: string[], scope: ProbeScope): number {
	function findInIdents(s: string, lastIndent: number): number {
		for (let i = lastIndent - 1; i >= 0; i--) {
			if (scopesAreMatching(s, identifers[i])) {
				return i;
			}
		}
		return -1;
	}
	if (scope.length < identifers.length) {
		return -1;
	}
	let lastScopeIndex = scope.length - 1;
	let lastIdentifierIndex = findInIdents(scope[lastScopeIndex--], identifers.length);
	if (lastIdentifierIndex >= 0) {
		const score = (lastIdentifierIndex + 1) * 0x10000 + scope.length;
		while (lastScopeIndex >= 0) {
			lastIdentifierIndex = findInIdents(scope[lastScopeIndex--], lastIdentifierIndex);
			if (lastIdentifierIndex === -1) {
				return -1;
			}
		}
		return score;
	}
	return -1;
}


function scopesAreMatching(thisScopeName: string, scopeName: string): boolean {
	if (!thisScopeName) {
		return false;
	}
	if (thisScopeName === scopeName) {
		return true;
	}
	const len = scopeName.length;
	return thisScopeName.length > len && thisScopeName.substr(0, len) === scopeName && thisScopeName[len] === '.';
}

function getScopeMatcher(rule: ITextMateThemingRule): Matcher<ProbeScope> {
	const ruleScope = rule.scope;
	if (!ruleScope || !rule.settings) {
		return noMatch;
	}
	const matchers: MatcherWithPriority<ProbeScope>[] = [];
	if (Array.isArray(ruleScope)) {
		for (let rs of ruleScope) {
			createMatchers(rs, nameMatcher, matchers);
		}
	} else {
		createMatchers(ruleScope, nameMatcher, matchers);
	}

	if (matchers.length === 0) {
		return noMatch;
	}
	return (scope: ProbeScope) => {
		let max = matchers[0].matcher(scope);
		for (let i = 1; i < matchers.length; i++) {
			max = Math.max(max, matchers[i].matcher(scope));
		}
		return max;
	};
}



function readCustomTokenStyleRules(tokenStylingRuleSection: IExperimentalTokenStyleCustomizations, result: TokenStylingRule[] = []) {
	for (let key in tokenStylingRuleSection) {
		if (key[0] !== '[') {
			const [type, ...modifiers] = key.split('.');
			const classification = tokenClassificationRegistry.getTokenClassification(type, modifiers);
			if (classification) {
				const settings = tokenStylingRuleSection[key];
				let style: TokenStyle | undefined;
				if (typeof settings === 'string') {
					style = TokenStyle.fromSettings(settings, undefined);
				} else if (isTokenColorizationSetting(settings)) {
					style = TokenStyle.fromSettings(settings.foreground, settings.fontStyle);
				}
				if (style) {
					result.push(tokenClassificationRegistry.getTokenStylingRule(classification, style));
				}
			}
		}
	}
	return result;
}

function isTokenColorizationSetting(style: any): style is ITokenColorizationSetting {
	return style && (style.foreground || style.fontStyle);
}


class TokenColorIndex {

	private _lastColorId: number;
	private _id2color: string[];
	private _color2id: { [color: string]: number; };

	constructor() {
		this._lastColorId = 0;
		this._id2color = [];
		this._color2id = Object.create(null);
	}

	public add(color: string | Color | undefined | null): number {
		if (color === null || color === undefined) {
			return 0;
		}
		color = normalizeColorForIndex(color);

		let value = this._color2id[color];
		if (value) {
			return value;
		}
		value = ++this._lastColorId;
		this._color2id[color] = value;
		this._id2color[value] = color;
		return value;
	}

	public get(color: string | Color | undefined): number {
		if (color === undefined) {
			return 0;
		}
		color = normalizeColorForIndex(color);
		let value = this._color2id[color];
		if (value) {
			return value;
		}
		console.log(`Color ${color} not in index.`);
		return 0;
	}

	public asArray(): string[] {
		return this._id2color.slice(0);
	}

}

function normalizeColorForIndex(color: string | Color): string {
	if (typeof color !== 'string') {
		color = Color.Format.CSS.formatHexA(color, true);
	}
	return color.toUpperCase();
}

function toMetadata(fontStyle: FontStyle, foreground: ColorId | number, background: ColorId | number) {
	const fontStyleBits = fontStyle << MetadataConsts.FONT_STYLE_OFFSET;
	const foregroundBits = foreground << MetadataConsts.FOREGROUND_OFFSET;
	const backgroundBits = background << MetadataConsts.BACKGROUND_OFFSET;
	if ((fontStyleBits & MetadataConsts.FONT_STYLE_MASK) !== fontStyleBits) {
		console.log(`Can not express fontStyle ${fontStyle} in metadata`);
	}
	if ((backgroundBits & MetadataConsts.BACKGROUND_MASK) !== backgroundBits) {
		console.log(`Can not express background ${background} in metadata`);
	}
	if ((foregroundBits & MetadataConsts.FOREGROUND_MASK) !== foregroundBits) {
		console.log(`Can not express foreground ${foreground} in metadata`);
	}
	return (fontStyleBits | foregroundBits | backgroundBits) >>> 0;
}
