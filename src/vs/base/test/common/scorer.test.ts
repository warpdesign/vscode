/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as assert from 'assert';
import * as scorer from 'vs/base/common/scorer';
import URI from 'vs/base/common/uri';
import { basename } from 'vs/base/common/paths';

class ResourceAccessor {

	static getBasename(resource: URI): string {
		return basename(resource.fsPath);
	}

	static getPath(resource: URI): string {
		return resource.fsPath;
	}
}

class NullAccessor {

	static getBasename(resource: URI): string {
		return void 0;
	}

	static getPath(resource: URI): string {
		return void 0;
	}
}

suite('Scorer', () => {

	test('score', function () {
		const target = 'HeLlo-World';

		const scores: scorer.Score[] = [];
		scores.push(scorer.score(target, 'HelLo-World')); // direct case match
		scores.push(scorer.score(target, 'hello-world')); // direct mix-case match
		scores.push(scorer.score(target, 'HW')); // direct case prefix (multiple)
		scores.push(scorer.score(target, 'hw')); // direct mix-case prefix (multiple)
		scores.push(scorer.score(target, 'H')); // direct case prefix
		scores.push(scorer.score(target, 'h')); // direct mix-case prefix
		scores.push(scorer.score(target, 'W')); // direct case word prefix
		scores.push(scorer.score(target, 'w')); // direct mix-case word prefix
		scores.push(scorer.score(target, 'Ld')); // in-string case match (multiple)
		scores.push(scorer.score(target, 'ld')); // in-string mix-case match
		scores.push(scorer.score(target, 'L')); // in-string case match
		scores.push(scorer.score(target, 'l')); // in-string mix-case match
		scores.push(scorer.score(target, '4')); // no match

		// Assert scoring order
		let sortedScores = scores.concat().sort((a, b) => b[0] - a[0]);
		assert.deepEqual(scores, sortedScores);

		// Assert scoring positions
		let positions = scores[0][1];
		assert.equal(positions.length, 'HelLo-World'.length);

		positions = scores[2][1];
		assert.equal(positions.length, 'HW'.length);
		assert.equal(positions[0], 0);
		assert.equal(positions[1], 6);
	});

	test('cache', function () {
		const cache = Object.create(null);

		scorer.score('target', 'query', cache);
		scorer.score('target', 't', cache);

		assert.equal(Object.getOwnPropertyNames(cache).length, 2);
	});

	test('scoreFile - matches are proper', function () {
		let res = scorer.scoreFile(null, ResourceAccessor, 'something');
		assert.ok(!res.score);

		const resource = URI.file('/xyz/some/path/someFile123.txt');

		res = scorer.scoreFile(resource, NullAccessor, 'something');
		assert.ok(!res.score);

		// Path Identity
		const identityRes = scorer.scoreFile(resource, ResourceAccessor, ResourceAccessor.getPath(resource));
		assert.ok(identityRes.score);
		assert.equal(identityRes.pathMatch.length, 1);
		assert.equal(identityRes.basenameMatch.length, 1);
		assert.equal(identityRes.pathMatch[0].start, 0);
		assert.equal(identityRes.pathMatch[0].end, ResourceAccessor.getPath(resource).length);
		assert.equal(identityRes.basenameMatch[0].start, 0);
		assert.equal(identityRes.basenameMatch[0].end, ResourceAccessor.getBasename(resource).length);

		// Basename Prefix
		const basenamePrefixRes = scorer.scoreFile(resource, ResourceAccessor, 'som');
		assert.ok(basenamePrefixRes.score);
		assert.ok(!basenamePrefixRes.pathMatch);
		assert.equal(basenamePrefixRes.basenameMatch.length, 1);
		assert.equal(basenamePrefixRes.basenameMatch[0].start, 0);
		assert.equal(basenamePrefixRes.basenameMatch[0].end, 'som'.length);

		// Basename Match
		const basenameRes = scorer.scoreFile(resource, ResourceAccessor, 'of');
		assert.ok(basenameRes.score);
		assert.ok(!basenameRes.pathMatch);
		assert.equal(basenameRes.basenameMatch.length, 2);
		assert.equal(basenameRes.basenameMatch[0].start, 1);
		assert.equal(basenameRes.basenameMatch[0].end, 2);
		assert.equal(basenameRes.basenameMatch[1].start, 4);
		assert.equal(basenameRes.basenameMatch[1].end, 5);

		// Path Match
		const pathRes = scorer.scoreFile(resource, ResourceAccessor, 'xyz123');
		assert.ok(pathRes.score);
		assert.ok(pathRes.pathMatch);
		assert.ok(!pathRes.basenameMatch);
		assert.equal(pathRes.pathMatch.length, 2);
		assert.equal(pathRes.pathMatch[0].start, 1);
		assert.equal(pathRes.pathMatch[0].end, 4);
		assert.equal(pathRes.pathMatch[1].start, 23);
		assert.equal(pathRes.pathMatch[1].end, 26);

		// No Match
		const noRes = scorer.scoreFile(resource, ResourceAccessor, '987');
		assert.ok(!noRes.score);
		assert.ok(!noRes.basenameMatch);
		assert.ok(!noRes.pathMatch);

		// Verify Scores
		assert.ok(identityRes.score > basenamePrefixRes.score);
		assert.ok(basenamePrefixRes.score > basenameRes.score);
		assert.ok(basenameRes.score > pathRes.score);
		assert.ok(pathRes.score > noRes.score);
	});

	test('compareFilesByScore - identity', function () {
		const resourceA = URI.file('/some/path/fileA.txt');
		const resourceB = URI.file('/some/path/other/fileB.txt');
		const resourceC = URI.file('/unrelated/some/path/other/fileC.txt');

		// Full resource A path
		let query = ResourceAccessor.getPath(resourceA);

		let res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		// Full resource B path
		query = ResourceAccessor.getPath(resourceB);

		res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);
	});

	test('compareFilesByScore - basename prefix', function () {
		const resourceA = URI.file('/some/path/fileA.txt');
		const resourceB = URI.file('/some/path/other/fileB.txt');
		const resourceC = URI.file('/unrelated/some/path/other/fileC.txt');

		// Full resource A basename
		let query = ResourceAccessor.getBasename(resourceA);

		let res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		// Full resource B basename
		query = ResourceAccessor.getBasename(resourceB);

		res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);
	});

	test('compareFilesByScore - basename scores', function () {
		const resourceA = URI.file('/some/path/fileA.txt');
		const resourceB = URI.file('/some/path/other/fileB.txt');
		const resourceC = URI.file('/unrelated/some/path/other/fileC.txt');

		// Resource A part of basename
		let query = 'fileA';

		let res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		// Resource B part of basename
		query = 'fileB';

		res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);
	});

	test('compareFilesByScore - path scores', function () {
		const resourceA = URI.file('/some/path/fileA.txt');
		const resourceB = URI.file('/some/path/other/fileB.txt');
		const resourceC = URI.file('/unrelated/some/path/other/fileC.txt');

		// Resource A part of path
		let query = 'pathfileA';

		let res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		// Resource B part of path
		query = 'pathfileB';

		res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceB);
		assert.equal(res[1], resourceA);
		assert.equal(res[2], resourceC);
	});

	test('compareFilesByScore - prefer shorter basenames', function () {
		const resourceA = URI.file('/some/path/fileA.txt');
		const resourceB = URI.file('/some/path/other/fileBLonger.txt');
		const resourceC = URI.file('/unrelated/the/path/other/fileC.txt');

		// Resource A part of path
		let query = 'somepath';

		let res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);
	});

	test('compareFilesByScore - prefer shorter paths', function () {
		const resourceA = URI.file('/some/path/fileA.txt');
		const resourceB = URI.file('/some/path/other/fileB.txt');
		const resourceC = URI.file('/unrelated/some/path/other/fileC.txt');

		// Resource A part of path
		let query = 'somepath';

		let res = [resourceA, resourceB, resourceC].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);

		res = [resourceC, resourceB, resourceA].sort((r1, r2) => scorer.compareFilesByScore(r1, r2, ResourceAccessor, query));
		assert.equal(res[0], resourceA);
		assert.equal(res[1], resourceB);
		assert.equal(res[2], resourceC);
	});
});