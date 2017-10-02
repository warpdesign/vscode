/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { compareAnything } from 'vs/base/common/comparers';
import { matchesPrefix, IMatch, createMatches } from 'vs/base/common/filters';
import { isEqual } from 'vs/base/common/paths';

export type Score = [number, number[]];

const NO_SCORE: Score = [0, []];

const wordPathBoundary = ['-', '_', ' ', '/', '\\', '.'];

// Based on material from:
/*!
BEGIN THIRD PARTY
*/
/*!
* string_score.js: String Scoring Algorithm 0.1.22
*
* http://joshaven.com/string_score
* https://github.com/joshaven/string_score
*
* Copyright (C) 2009-2014 Joshaven Potter <yourtech@gmail.com>
* Special thanks to all of the contributors listed here https://github.com/joshaven/string_score
* MIT License: http://opensource.org/licenses/MIT
*
* Date: Tue Mar 1 2011
* Updated: Tue Mar 10 2015
*/

/**
 * Compute a score for the given string and the given query.
 *
 * Rules:
 * Character score: 1
 * Same case bonus: 1
 * Upper case bonus: 1
 * Consecutive match bonus: 5
 * Start of word/path bonus: 7
 * Start of string bonus: 8
 */
export function score(target: string, query: string, cache?: { [id: string]: Score }): Score {
	if (!target || !query) {
		return NO_SCORE; // return early if target or query are undefined
	}

	if (target.length < query.length) {
		return NO_SCORE; // impossible for query to be contained in target
	}

	const hash = target + query;
	const cached = cache && cache[hash];
	if (Array.isArray(cached)) {
		return cached;
	}

	// console.group(`Target: ${target}, Query: ${query}`);

	const queryLen = query.length;
	const targetLower = target.toLowerCase();
	const queryLower = query.toLowerCase();

	const matchingPositions: number[] = [];

	let index = 0;
	let startAt = 0;
	let score = 0;
	while (index < queryLen) {
		let indexOf = targetLower.indexOf(queryLower[index], startAt);
		if (indexOf < 0) {

			// console.log(`Character not part of target ${query[index]}`);

			score = 0; // This makes sure that the query is contained in the target
			break;
		}

		// Fill into positions array
		matchingPositions.push(indexOf);

		// Character match bonus
		score += 1;

		// console.groupCollapsed(`%cCharacter match bonus: +1 (char: ${query[index]} at index ${indexOf}, total score: ${score})`, 'font-weight: normal');

		// Consecutive match bonus
		if (startAt === indexOf && index > 0) {
			score += 5;

			// console.log('Consecutive match bonus: +5');
		}

		// Same case bonus
		if (target[indexOf] === query[index]) {
			score += 1;

			// console.log('Same case bonus: +1');
		}

		// Start of word bonus
		if (indexOf === 0) {
			score += 8;

			// console.log('Start of word bonus: +8');
		}

		// After separator bonus
		else if (wordPathBoundary.some(w => w === target[indexOf - 1])) {
			score += 7;

			// console.log('After separtor bonus: +7');
		}

		// Inside word upper case bonus
		else if (isUpper(target.charCodeAt(indexOf))) {
			score += 1;

			// console.log('Inside word upper case bonus: +1');
		}

		// console.groupEnd();

		startAt = indexOf + 1;
		index++;
	}

	const res: Score = (score > 0) ? [score, matchingPositions] : NO_SCORE;

	// console.log(`%cFinal Score: ${score}`, 'font-weight: bold');
	// console.groupEnd();

	if (cache) {
		cache[hash] = res;
	}

	return res;
}

function isUpper(code: number): boolean {
	return 65 <= code && code <= 90;
}
/*!
END THIRD PARTY
*/

export interface IFileScore {

	/**
	 * Overall score on the file.
	 */
	score: number;

	/**
	 * Matches within the basename of the file.
	 */
	basenameMatch?: IMatch[];

	/**
	 * Matches within the full path of the file.
	 */
	pathMatch?: IMatch[];
}

const NO_FILE_SCORE: IFileScore = { score: 0 };

export interface IFileAccessor<T> {
	getBasename(file: T): string;
	getPath(file: T): string;
}

const PATH_IDENTITY_SCORE = 1 << 18;
const BASENAME_PREFIX_SCORE = 1 << 17;
const BASENAME_SCORE_THRESHOLD = 1 << 16;

/**
 * Scoring files is different from scoring arbritrary words because files have some semantic: their path. Instead
 * of just scoring the file path, we do some checks on other parts of the path to decide the score.
 */
export function scoreFile<T>(file: T, accessor: IFileAccessor<T>, query: string, cache?: { [key: string]: Score }): IFileScore {
	if (!file) {
		return NO_FILE_SCORE; // we need a file at least
	}

	const basename = accessor.getBasename(file);
	const path = accessor.getPath(file);

	if (!basename || !path) {
		return NO_FILE_SCORE; // we also need basename and path
	}

	// 1.) treat identity matches on files highest
	if (isEqual(query, path, true)) {
		return { score: PATH_IDENTITY_SCORE, pathMatch: [{ start: 0, end: path.length }], basenameMatch: [{ start: 0, end: basename.length }] };
	}

	// 2.) treat prefix matches on the file basename second highest
	const prefixBasenameMatch = matchesPrefix(query, basename);
	if (prefixBasenameMatch) {
		return { score: BASENAME_PREFIX_SCORE, basenameMatch: prefixBasenameMatch };
	}

	// 3.) prefer scores on the basename if any
	const [basenameScore, basenamePositions] = score(basename, query, cache);
	if (basenameScore) {
		return { score: basenameScore + BASENAME_SCORE_THRESHOLD, basenameMatch: createMatches(basenamePositions) };
	}

	// 4.) finally compute path scores
	const [pathScore, pathPositions] = score(path, query, cache);
	if (pathScore) {
		return { score: pathScore, pathMatch: createMatches(pathPositions) };
	}

	return NO_FILE_SCORE;
}

export function compareFilesByScore<T>(fileA: T, fileB: T, accessor: IFileAccessor<T>, query: string, cache?: { [key: string]: Score }): number {
	const scoreA = scoreFile(fileA, accessor, query, cache).score;
	const scoreB = scoreFile(fileB, accessor, query, cache).score;

	// 1.) check for identity matches
	if (scoreA === PATH_IDENTITY_SCORE || scoreB === PATH_IDENTITY_SCORE) {
		if (scoreA !== scoreB) {
			return scoreA === PATH_IDENTITY_SCORE ? -1 : 1;
		}
	}

	// 2.) check for basename prefix matches
	if (scoreA === BASENAME_PREFIX_SCORE || scoreB === BASENAME_PREFIX_SCORE) {
		if (scoreA !== scoreB) {
			return scoreA === BASENAME_PREFIX_SCORE ? -1 : 1;
		}

		const basenameA = accessor.getBasename(fileA);
		const basenameB = accessor.getBasename(fileB);

		// prefer shorter basenames when both match on basename prefix
		if (basenameA.length !== basenameB.length) {
			return basenameA.length - basenameB.length;
		}
	}

	// 3.) check for basename scores
	if (scoreA > BASENAME_SCORE_THRESHOLD || scoreB > BASENAME_SCORE_THRESHOLD) {
		if (scoreB < BASENAME_SCORE_THRESHOLD) {
			return -1;
		}

		if (scoreA < BASENAME_SCORE_THRESHOLD) {
			return 1;
		}
	}

	// 4.) check for path scores
	if (scoreA !== scoreB) {
		return scoreA > scoreB ? -1 : 1;
	}

	// 5.) at this point, scores are identical for both paths

	const basenameA = accessor.getBasename(fileA);
	const basenameB = accessor.getBasename(fileB);

	if (basenameA.length !== basenameB.length) {
		return basenameA.length - basenameB.length; // prefer shorter basenames
	}

	const pathA = accessor.getPath(fileA);
	const pathB = accessor.getPath(fileB);

	if (pathA.length !== pathB.length) {
		return pathA.length - pathB.length; // prefer shorter paths
	}

	if (basenameA !== basenameB) {
		return compareAnything(basenameA, basenameB, query); // compare by basename if they differ
	}

	// Finally compare by absolute paths
	return compareAnything(pathA, pathB, query);
}