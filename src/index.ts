/**
 * GitHub Action entry point.
 */
import * as core from '@actions/core';
import { describeError } from './errors.js';
import { run } from './main.js';

void run().catch((err: unknown) => {
  core.setFailed(`Unhandled error in Gemini PR Reviewer: ${describeError(err)}`);
});

