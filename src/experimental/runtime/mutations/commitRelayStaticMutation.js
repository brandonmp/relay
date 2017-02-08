/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule commitRelayStaticMutation
 * @flow
 */

'use strict';

import type {GraphQLTaggedNode} from 'RelayStaticGraphQLTag';
import type {
  Disposable,
  Environment,
  RecordSourceProxy,
  RecordSourceSelectorProxy,
} from 'RelayStoreTypes';
import type {RelayMutationConfig} from 'RelayTypes';
import type {Variables} from 'RelayTypes';

export type MutationConfig = {|
  configs?: Array<RelayMutationConfig>,
  mutation: GraphQLTaggedNode,
  variables: Variables,
  onCompleted?: ?(response: ?Object) => void,
  onError?: ?(error: Error) => void,
  optimisticUpdater?: ?(proxy: RecordSourceProxy) => void,
  optimisticResponse?: ?() => Object,
  updater?: ?(proxy: RecordSourceSelectorProxy) => void,
|};

/**
 * Higher-level helper function to execute a mutation against a specific
 * environment.
 */
function commitRelayStaticMutation(
  environment: Environment,
  config: MutationConfig
): Disposable {
  const {
    createOperationSelector,
    getOperation,
  } = environment.unstable_internal;
  const mutation = getOperation(config.mutation);
  const {
    onError,
    optimisticUpdater,
    updater,
    variables,
  } = config;
  const operation = createOperationSelector(mutation, variables);
  return environment.sendMutation({
    onError,
    operation,
    optimisticUpdater,
    updater,
    onCompleted() {
      const {onCompleted} = config;
      if (onCompleted) {
        const snapshot = environment.lookup(operation.fragment);
        onCompleted(snapshot.data);
      }
    },
  });
}

module.exports = commitRelayStaticMutation;
