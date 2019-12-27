/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IUserDataSyncService, SyncStatus, SyncSource, CONTEXT_SYNC_STATE, IUserDataSyncStore, registerConfiguration, getUserDataSyncStore } from 'vs/platform/userDataSync/common/userDataSync';
import { localize } from 'vs/nls';
import { Disposable, MutableDisposable, toDisposable, DisposableStore } from 'vs/base/common/lifecycle';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { MenuRegistry, MenuId, IMenuItem } from 'vs/platform/actions/common/actions';
import { IContextKeyService, IContextKey, ContextKeyExpr, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IActivityService, IBadge, NumberBadge, ProgressBadge } from 'vs/workbench/services/activity/common/activity';
import { GLOBAL_ACTIVITY_ID } from 'vs/workbench/common/activity';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { URI } from 'vs/base/common/uri';
import { registerAndGetAmdImageURL } from 'vs/base/common/amd';
import { ResourceContextKey } from 'vs/workbench/common/resources';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { Event } from 'vs/base/common/event';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { isEqual } from 'vs/base/common/resources';
import { IEditorInput } from 'vs/workbench/common/editor';
import { IAuthTokenService, AuthTokenStatus } from 'vs/platform/auth/common/auth';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { FalseContext } from 'vs/platform/contextkey/common/contextkeys';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { isWeb } from 'vs/base/common/platform';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { UserDataAutoSync } from 'vs/workbench/contrib/userDataSync/browser/userDataAutoSync';
import { UserDataSyncTrigger } from 'vs/workbench/contrib/userDataSync/browser/userDataSyncTrigger';
import { timeout } from 'vs/base/common/async';

const CONTEXT_AUTH_TOKEN_STATE = new RawContextKey<string>('authTokenStatus', AuthTokenStatus.Initializing);
const SYNC_PUSH_LIGHT_ICON_URI = URI.parse(registerAndGetAmdImageURL(`vs/workbench/contrib/userDataSync/browser/media/check-light.svg`));
const SYNC_PUSH_DARK_ICON_URI = URI.parse(registerAndGetAmdImageURL(`vs/workbench/contrib/userDataSync/browser/media/check-dark.svg`));

export class UserDataSyncWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	private static readonly ENABLEMENT_SETTING = 'sync.enable';

	private readonly userDataSyncStore: IUserDataSyncStore | undefined;
	private readonly syncStatusContext: IContextKey<string>;
	private readonly authTokenContext: IContextKey<string>;
	private readonly badgeDisposable = this._register(new MutableDisposable());
	private readonly conflictsWarningDisposable = this._register(new MutableDisposable());
	private readonly signInNotificationDisposable = this._register(new MutableDisposable());

	constructor(
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IAuthTokenService private readonly authTokenService: IAuthTokenService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActivityService private readonly activityService: IActivityService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IHistoryService private readonly historyService: IHistoryService,
		@IWorkbenchEnvironmentService private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.userDataSyncStore = getUserDataSyncStore(configurationService);
		this.syncStatusContext = CONTEXT_SYNC_STATE.bindTo(contextKeyService);
		this.authTokenContext = CONTEXT_AUTH_TOKEN_STATE.bindTo(contextKeyService);

		if (this.userDataSyncStore) {
			registerConfiguration();
			this.onDidChangeAuthTokenStatus(this.authTokenService.status);
			this.onDidChangeSyncStatus(this.userDataSyncService.status);
			this._register(Event.debounce(authTokenService.onDidChangeStatus, () => undefined, 500)(() => this.onDidChangeAuthTokenStatus(this.authTokenService.status)));
			this._register(Event.debounce(userDataSyncService.onDidChangeStatus, () => undefined, 500)(() => this.onDidChangeSyncStatus(this.userDataSyncService.status)));
			this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING))(() => this.onDidChangeEnablement()));
			this.registerActions();

			if (isWeb) {
				this._register(instantiationService.createInstance(UserDataAutoSync));
			} else {
				this._register(instantiationService.createInstance(UserDataSyncTrigger).onDidTriggerSync(() => this.triggerSync()));
			}
		}
	}

	private triggerSync(): void {
		if (this.configurationService.getValue<boolean>('sync.enable')
			&& this.userDataSyncService.status !== SyncStatus.Uninitialized
			&& this.authTokenService.status === AuthTokenStatus.SignedIn) {
			this.userDataSyncService.sync();
		}
	}

	private onDidChangeAuthTokenStatus(status: AuthTokenStatus) {
		this.authTokenContext.set(status);
		if (status === AuthTokenStatus.SignedIn) {
			this.signInNotificationDisposable.clear();
		}
		this.updateBadge();
	}

	private onDidChangeSyncStatus(status: SyncStatus) {
		this.syncStatusContext.set(status);

		if (status === SyncStatus.Syncing) {
			// Show syncing progress if takes more than 1s.
			timeout(1000).then(() => this.updateBadge());
		} else {
			this.updateBadge();
		}

		if (this.userDataSyncService.status === SyncStatus.HasConflicts) {
			if (!this.conflictsWarningDisposable.value) {
				const handle = this.notificationService.prompt(Severity.Warning, localize('conflicts detected', "Unable to sync due to conflicts. Please resolve them to continue."),
					[
						{
							label: localize('resolve', "Resolve Conflicts"),
							run: () => this.handleConflicts()
						}
					]);
				this.conflictsWarningDisposable.value = toDisposable(() => handle.close());
				handle.onDidClose(() => this.conflictsWarningDisposable.clear());
			}
		} else {
			const previewEditorInput = this.getPreviewEditorInput();
			if (previewEditorInput) {
				previewEditorInput.dispose();
			}
			this.conflictsWarningDisposable.clear();
		}
	}

	private onDidChangeEnablement() {
		this.updateBadge();
		const enabled = this.configurationService.getValue<boolean>(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING);
		if (enabled) {
			if (this.authTokenService.status === AuthTokenStatus.SignedOut) {
				const handle = this.notificationService.prompt(Severity.Info, localize('ask to sign in', "Please sign in with your {0} account to sync configuration across all your machines", this.userDataSyncStore!.account),
					[
						{
							label: localize('Sign in', "Sign in"),
							run: () => this.signIn()
						}
					]);
				this.signInNotificationDisposable.value = toDisposable(() => handle.close());
				handle.onDidClose(() => this.signInNotificationDisposable.clear());
			}
		} else {
			this.signInNotificationDisposable.clear();
		}
	}

	private updateBadge(): void {
		this.badgeDisposable.clear();

		let badge: IBadge | undefined = undefined;
		let clazz: string | undefined;
		let priority: number | undefined = undefined;

		if (this.userDataSyncService.status !== SyncStatus.Uninitialized && this.configurationService.getValue<boolean>(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING) && this.authTokenService.status === AuthTokenStatus.SignedOut) {
			badge = new NumberBadge(1, () => localize('sign in to sync', "Sign in to Sync"));
		} else if (this.authTokenService.status === AuthTokenStatus.SigningIn) {
			badge = new ProgressBadge(() => localize('signing in', "Signing in..."));
			clazz = 'progress-badge';
			priority = 1;
		} else if (this.userDataSyncService.status === SyncStatus.HasConflicts) {
			badge = new NumberBadge(1, () => localize('resolve conflicts', "Resolve Conflicts"));
		} else if (this.userDataSyncService.status === SyncStatus.Syncing) {
			badge = new ProgressBadge(() => localize('syncing', "Synchronizing User Configuration..."));
			clazz = 'progress-badge';
			priority = 1;
		}

		if (badge) {
			this.badgeDisposable.value = this.activityService.showActivity(GLOBAL_ACTIVITY_ID, badge, clazz, priority);
		}
	}

	private async turnOn(): Promise<void> {
		if (this.authTokenService.status === AuthTokenStatus.SignedOut) {
			const result = await this.dialogService.confirm({
				type: 'info',
				message: localize('sign in to account', "Sign in to {0}", this.userDataSyncStore!.name),
				detail: localize('ask to sign in', "Please sign in with your {0} account to sync configuration across all your machines", this.userDataSyncStore!.account),
				primaryButton: localize('Sign in', "Sign in")
			});
			if (!result.confirmed) {
				return;
			}
			await this.signIn();
		}
		await this.configureSyncOptions();
		await this.configurationService.updateValue(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING, true);
		this.notificationService.info(localize('Sync Started', "Sync Started."));
	}

	private async configureSyncOptions(): Promise<void> {
		return new Promise((c, e) => {
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick();
			disposables.add(quickPick);
			quickPick.title = localize('configure sync title', "Sync: Configure");
			quickPick.placeholder = localize('select configurations to sync', "Choose what to sync");
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			const items = [{
				id: 'sync.enableSettings',
				label: localize('user settings', "User Settings")
			}, {
				id: 'sync.enableKeybindings',
				label: localize('user keybindings', "User Keybindings")
			}, {
				id: 'sync.enableExtensions',
				label: localize('extensions', "Extensions")
			}];
			quickPick.items = items;
			quickPick.selectedItems = items.filter(item => this.configurationService.getValue(item.id));
			disposables.add(quickPick.onDidAccept(() => {
				for (const item of items) {
					const wasEnabled = this.configurationService.getValue(item.id);
					const isEnabled = !!quickPick.selectedItems.filter(selected => selected.id === item.id)[0];
					if (wasEnabled !== isEnabled) {
						this.configurationService.updateValue(item.id!, isEnabled);
					}
				}
				quickPick.hide();
			}));
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				c();
			}));
			quickPick.show();
		});
	}

	private async turnOff(): Promise<void> {
		await this.configurationService.updateValue(UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING, false);
	}

	private async signIn(): Promise<void> {
		try {
			await this.authTokenService.login();
		} catch (e) {
			this.notificationService.error(e);
			throw e;
		}
	}

	private async signOut(): Promise<void> {
		await this.authTokenService.logout();
	}

	private async continueSync(): Promise<void> {
		// Get the preview editor
		const previewEditorInput = this.getPreviewEditorInput();
		// Save the preview
		if (previewEditorInput && previewEditorInput.isDirty()) {
			await this.textFileService.save(previewEditorInput.getResource()!);
		}
		try {
			// Continue Sync
			await this.userDataSyncService.sync(true);
		} catch (error) {
			this.notificationService.error(error);
			return;
		}
		// Close the preview editor
		if (previewEditorInput) {
			previewEditorInput.dispose();
		}
	}

	private getPreviewEditorInput(): IEditorInput | undefined {
		return this.editorService.editors.filter(input => isEqual(input.getResource(), this.workbenchEnvironmentService.settingsSyncPreviewResource) || isEqual(input.getResource(), this.workbenchEnvironmentService.keybindingsSyncPreviewResource))[0];
	}

	private async handleConflicts(): Promise<void> {
		const conflictsResource = this.getConflictsResource();
		if (conflictsResource) {
			const resourceInput = {
				resource: conflictsResource,
				options: {
					preserveFocus: false,
					pinned: false,
					revealIfVisible: true,
				},
				mode: 'jsonc'
			};
			this.editorService.openEditor(resourceInput)
				.then(editor => {
					this.historyService.remove(resourceInput);
					if (editor && editor.input) {
						// Trigger sync after closing the conflicts editor.
						const disposable = editor.input.onDispose(() => {
							disposable.dispose();
							this.userDataSyncService.sync(true);
						});
					}
				});
		}
	}

	private getConflictsResource(): URI | null {
		if (this.userDataSyncService.conflictsSource === SyncSource.Settings) {
			return this.workbenchEnvironmentService.settingsSyncPreviewResource;
		}
		if (this.userDataSyncService.conflictsSource === SyncSource.Keybindings) {
			return this.workbenchEnvironmentService.keybindingsSyncPreviewResource;
		}
		return null;
	}

	private registerActions(): void {

		const turnOnSyncCommandId = 'workbench.userData.actions.syncStart';
		const turnOnSyncWhenContext = ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), ContextKeyExpr.not(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`), CONTEXT_AUTH_TOKEN_STATE.notEqualsTo(AuthTokenStatus.SigningIn));
		CommandsRegistry.registerCommand(turnOnSyncCommandId, () => this.turnOn());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: turnOnSyncCommandId,
				title: localize('global activity turn on sync', "Turn on sync...")
			},
			when: turnOnSyncWhenContext,
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: turnOnSyncCommandId,
				title: localize('turn on sync', "Sync: Turn on sync...")
			},
			when: turnOnSyncWhenContext,
		});

		const signInCommandId = 'workbench.userData.actions.signin';
		const signInWhenContext = ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), ContextKeyExpr.has(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`), CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.SignedOut));
		CommandsRegistry.registerCommand(signInCommandId, () => this.signIn());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: signInCommandId,
				title: localize('global activity sign in', "Sign in to sync... (1)")
			},
			when: signInWhenContext,
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: signInCommandId,
				title: localize('sign in', "Sync: Sign in to sync...")
			},
			when: signInWhenContext,
		});

		const signingInCommandId = 'workbench.userData.actions.signingin';
		CommandsRegistry.registerCommand(signingInCommandId, () => null);
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: signingInCommandId,
				title: localize('signinig in', "Signing in..."),
				precondition: FalseContext
			},
			when: CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.SigningIn)
		});

		const stopSyncCommandId = 'workbench.userData.actions.stopSync';
		CommandsRegistry.registerCommand(stopSyncCommandId, () => this.turnOff());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: stopSyncCommandId,
				title: localize('global activity stop sync', "Turn off sync")
			},
			when: ContextKeyExpr.and(ContextKeyExpr.has(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`), CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.SignedIn), CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.HasConflicts))
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: stopSyncCommandId,
				title: localize('stop sync', "Sync: Turn off sync")
			},
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.notEqualsTo(SyncStatus.Uninitialized), ContextKeyExpr.has(`config.${UserDataSyncWorkbenchContribution.ENABLEMENT_SETTING}`)),
		});

		const resolveConflictsCommandId = 'workbench.userData.actions.resolveConflicts';
		const resolveConflictsWhenContext = CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts);
		CommandsRegistry.registerCommand(resolveConflictsCommandId, () => this.handleConflicts());
		MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
			group: '5_sync',
			command: {
				id: resolveConflictsCommandId,
				title: localize('resolveConflicts_global', "Resolve sync conflicts (1)"),
			},
			when: resolveConflictsWhenContext,
		});
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: resolveConflictsCommandId,
				title: localize('resolveConflicts', "Sync: Resolve sync conflicts"),
			},
			when: resolveConflictsWhenContext,
		});

		const continueSyncCommandId = 'workbench.userData.actions.continueSync';
		CommandsRegistry.registerCommand(continueSyncCommandId, () => this.continueSync());
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: continueSyncCommandId,
				title: localize('continue sync', "Sync: Continue sync")
			},
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts)),
		});
		MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
			command: {
				id: continueSyncCommandId,
				title: localize('continue sync', "Sync: Continue sync"),
				icon: {
					light: SYNC_PUSH_LIGHT_ICON_URI,
					dark: SYNC_PUSH_DARK_ICON_URI
				}
			},
			group: 'navigation',
			order: 1,
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts), ResourceContextKey.Resource.isEqualTo(this.workbenchEnvironmentService.settingsSyncPreviewResource.toString())),
		});
		MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
			command: {
				id: continueSyncCommandId,
				title: localize('continue sync', "Sync: Continue sync"),
				icon: {
					light: SYNC_PUSH_LIGHT_ICON_URI,
					dark: SYNC_PUSH_DARK_ICON_URI
				}
			},
			group: 'navigation',
			order: 1,
			when: ContextKeyExpr.and(CONTEXT_SYNC_STATE.isEqualTo(SyncStatus.HasConflicts), ResourceContextKey.Resource.isEqualTo(this.workbenchEnvironmentService.keybindingsSyncPreviewResource.toString())),
		});

		const signOutMenuItem: IMenuItem = {
			group: '5_sync',
			command: {
				id: 'workbench.userData.actions.signout',
				title: localize('sign out', "Sync: Sign out")
			},
			when: ContextKeyExpr.and(CONTEXT_AUTH_TOKEN_STATE.isEqualTo(AuthTokenStatus.SignedIn)),
		};
		CommandsRegistry.registerCommand(signOutMenuItem.command.id, () => this.signOut());
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, signOutMenuItem);
	}
}
