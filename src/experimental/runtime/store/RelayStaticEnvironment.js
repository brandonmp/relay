/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule RelayStaticEnvironment
 * @flow
 */

'use strict';

const RelayCore = require('RelayCore');
const RelayPublishQueue = require('RelayPublishQueue');

const normalizeRelayPayload = require('normalizeRelayPayload');

import type {
  CacheConfig,
  Network,
  PayloadData,
  RelayResponsePayload,
} from 'RelayNetworkTypes';
import type {
  Disposable,
  Handler,
  OperationSelector,
  Selector,
  SelectorStoreUpdater,
  Snapshot,
  Store,
  StoreUpdater,
  UnstableEnvironmentCore,
} from 'RelayStoreTypes';

export type EnvironmentConfig = {
  handleProvider: ?HandlerProvider,
  network: Network,
  store: Store,
};
export type HandlerProvider = (name: string) => ?Handler;

/**
 * Implements the `Environment` interface defined in RelayStoreTypes.
 */
class RelayStaticEnvironment {
  _network: Network;
  _publishQueue: RelayPublishQueue;
  _store: Store;
  unstable_internal: UnstableEnvironmentCore;

  constructor(config: EnvironmentConfig) {
    this._network = config.network;
    this._publishQueue = new RelayPublishQueue(config.store, config.handleProvider);
    this._store = config.store;
    this.unstable_internal = RelayCore;
  }

  getStore(): Store {
    return this._store;
  }

  applyUpdate(updater: StoreUpdater): Disposable {
    const dispose = () => {
      this._publishQueue.revertUpdate(updater);
      this._publishQueue.run();
    };
    this._publishQueue.applyUpdate(updater);
    this._publishQueue.run();
    return {dispose};
  }

  commitPayload(
    selector: Selector,
    payload: PayloadData,
  ): void {
    // Do not handle stripped nulls when commiting a payload
    const relayPayload = normalizeRelayPayload(selector, payload);
    this._publishQueue.commitPayload(selector, relayPayload);
    this._publishQueue.run();
  }

  lookup(selector: Selector): Snapshot {
    return this._store.lookup(selector);
  }

  subscribe(
    snapshot: Snapshot,
    callback: (snapshot: Snapshot) => void,
  ): Disposable {
    return this._store.subscribe(snapshot, callback);
  }

  retain(selector: Selector): Disposable {
    return this._store.retain(selector);
  }

  sendQuery({
    cacheConfig,
    onCompleted,
    onError,
    onNext,
    operation,
  }: {
    cacheConfig?: ?CacheConfig,
    onCompleted?: ?() => void,
    onError?: ?(error: Error) => void,
    onNext?: ?(payload: RelayResponsePayload) => void,
    operation: OperationSelector,
  }): Disposable {
    let isDisposed = false;
    const dispose = () => {
      isDisposed = true;
    };
    this._network.request(operation.node, operation.variables, cacheConfig).then(payload => {
      if (isDisposed) {
        return;
      }
      this._publishQueue.commitPayload(operation.fragment, payload);
      this._publishQueue.run();
      onNext && onNext(payload);
      onCompleted && onCompleted();
    }).catch(error => {
      if (isDisposed) {
        return;
      }
      onError && onError(error);
    });
    return {dispose};
  }

  sendQuerySubscription({
    cacheConfig,
    onCompleted,
    onError,
    onNext,
    operation,
  }: {
    cacheConfig?: ?CacheConfig,
    onCompleted?: ?() => void,
    onError?: ?(error: Error) => void,
    onNext?: ?(payload: RelayResponsePayload) => void,
    operation: OperationSelector,
  }): Disposable {
    return this._network.requestSubscription(
      operation.node,
      operation.variables,
      cacheConfig,
      {
        onCompleted,
        onError,
        onNext: payload => {
          this._publishQueue.commitPayload(operation.fragment, payload);
          this._publishQueue.run();
          onNext && onNext(payload);
        },
      },
    );
  }

  sendMutation({
    onCompleted,
    onError,
    operation,
    optimisticUpdater,
    updater,
  }: {
    onCompleted?: ?() => void,
    onError?: ?(error: Error) => void,
    operation: OperationSelector,
    optimisticUpdater?: ?StoreUpdater,
    updater?: ?SelectorStoreUpdater,
  }): Disposable {
    if (optimisticUpdater) {
      this._publishQueue.applyUpdate(optimisticUpdater);
      this._publishQueue.run();
    }
    let isDisposed = false;
    const dispose = () => {
      if (optimisticUpdater) {
        this._publishQueue.revertUpdate(optimisticUpdater);
        this._publishQueue.run();
        optimisticUpdater = null;
      }
      isDisposed = true;
    };
    this._network.request(
      operation.node,
      operation.variables,
      {force: true},
    ).then(payload => {
      if (isDisposed) {
        return;
      }
      if (optimisticUpdater) {
        this._publishQueue.revertUpdate(optimisticUpdater);
      }
      this._publishQueue.commitPayload(operation.fragment, payload, updater);
      this._publishQueue.run();
      onCompleted && onCompleted();
    }).catch(error => {
      if (isDisposed) {
        return;
      }
      if (optimisticUpdater) {
        this._publishQueue.revertUpdate(optimisticUpdater);
      }
      this._publishQueue.run();
      onError && onError(error);
    });
    return {dispose};
  }
}

module.exports = RelayStaticEnvironment;
