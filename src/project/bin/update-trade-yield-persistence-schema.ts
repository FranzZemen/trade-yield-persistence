#!/usr/bin/env node

/*
Created by Franz Zemen 05/11/2026
License Type: UNLICENSED
*/

import {input} from '@inquirer/prompts';
import {ExecutionContext} from '@franzzemen/execution-context';
import {AWSContext, awsContextKey} from '@franzzemen/aws-app/context';
import {LoggerApi} from '@franzzemen/logger';
import {endpointContextKey} from '@franzzemen/endpoint-application';
import {LoadExecutionConfigsFunctionInputs, loadNodeExecutionContext} from '@franzzemen/execution-context-node-loader';
import {updateTradeYieldPersistenceSchema} from '../schema/trade-yield-persistence-schema.js';

const endpointContextKeyDummy = endpointContextKey;

async function updateSchema(set?: string): Promise<void> {
  try {
    const secret = await input({message: 'Enter configuration secret'});
    const inputs: LoadExecutionConfigsFunctionInputs = {
      secret,
      jsonEncryptPath: './config.json.encrypt',
      jsonFilePath: './config.json',
      executionName: 'trade-yield-persistence-update-schema',
    };
    await loadNodeExecutionContext(inputs);
    const ec = new ExecutionContext();
    await LoggerApi.load(ec);
    console.log(`Tableset: ${set}`);
    const awsContext = ec.get<AWSContext>(awsContextKey);
    if (!awsContext) {
      throw new Error('No AWS configuration found');
    }
    if (set) {
      ec.putSub(awsContextKey, 'dynamo.currentTableSet', set);
    }
    const log = new LoggerApi(ec, 'trade-yield-persistence', 'bin', 'updateSchema');

    await updateTradeYieldPersistenceSchema(ec, (progress: string, percent: number | undefined) => {
      log.info(`${progress} ${percent}%`);
    });

    // NOTE: Trade-yield-segment tables intentionally have NO TTL. Stale rows
    // are removed by cascade-delete keyed on tradeUuid (when a trade rotates
    // uuid or is deleted) and by per-context fact-row replacement on each
    // summary write.
  } catch (err) {
    console.error(err);
  }
}

await updateSchema('production');
await updateSchema('test');
