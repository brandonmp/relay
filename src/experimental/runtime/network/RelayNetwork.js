/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule RelayNetwork
 * @flow
 */

'use strict';

const RelayError = require('RelayError');

const normalizeRelayPayload = require('normalizeRelayPayload');
const warning = require('warning');

const {ROOT_ID} = require('RelayStoreUtils');

import type {ConcreteBatch} from 'RelayConcreteNode';
import type {
  CacheConfig,
  FetchFunction,
  Network,
  QueryPayload,
  RelayResponsePayload,
} from 'RelayNetworkTypes';
import type {Disposable, Observer} from 'RelayStoreTypes';
import type {Variables} from 'RelayTypes';

/**
 * Creates an implementation of the `Network` interface defined in
 * `RelayNetworkTypes` given a single `fetch` function.
 */
function create(
  fetch: FetchFunction
): Network {
  async function request(
    operation: ConcreteBatch,
    variables: Variables,
    cacheConfig?: ?CacheConfig,
  ): Promise<RelayResponsePayload> {
    const payload = await fetch(operation, variables, cacheConfig);
    return normalizePayload(operation, variables, payload);
  }

  function requestSubscription(
    operation: ConcreteBatch,
    variables: Variables,
    cacheConfig: ?CacheConfig,
    {onCompleted, onError, onNext}: Observer<RelayResponsePayload>,
  ): Disposable {
    let isDisposed = false;
    fetch(operation, variables, cacheConfig).then(
      payload => {
        if (isDisposed) {
          return;
        }
        let relayPayload;
        try {
          relayPayload = normalizePayload(operation, variables, payload);
        } catch (err) {
          onError && onError(err);
          return;
        }
        onNext && onNext(relayPayload);
        onCompleted && onCompleted();
      },
      error => {
        if (isDisposed) {
          return;
        }
        onError && onError(error);
      }
    );
    return {
      dispose() {
        isDisposed = true;
      },
    };
  }

  return {
    fetch,
    request,
    requestSubscription,
  };
}

function normalizePayload(
  operation: ConcreteBatch,
  variables: Variables,
  payload: QueryPayload,
): RelayResponsePayload {
  const {data, errors} = (payload: any);
  if (data != null) {
    if (errors && errors.length) {
      warning(
        false,
        'RelayNetwork: Operation completed but had errors:\n' +
        'Operation: %s\n' +
        'Variables:\n%s\n' +
        'Errors:\n%s',
        operation.name,
        JSON.stringify(variables),
        errors.map(({message}) => `- ${String(message)}`).join('\n'),
      );
    }
    return normalizeRelayPayload(
      {
        dataID: ROOT_ID,
        node: operation.query,
        variables,
      },
      data,
      {handleStrippedNulls: true},
    );
  }
  const error = RelayError.create(
    'RelayNetwork',
    'No data returned for operation `%s`, got error(s):\n%s\n\nSee the error ' +
    '`source` property for more information.',
    operation.name,
    errors ? errors.map(({message}) => message).join('\n') : '(No errors)',
  );
  (error: any).source = {errors, operation, variables};
  throw error;
}

module.exports = {create};
