/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @providesModule RelayConnectionTransform
 */

'use strict';

const GraphQL = require('graphql');
const RelayCompilerContext = require('RelayCompilerContext');
const RelayIRTransformer = require('RelayIRTransformer');
const RelaySchemaUtils = require('RelaySchemaUtils');

const getRelayLiteralArgumentValues = require('getRelayLiteralArgumentValues');
const invariant = require('invariant');

const {
  CONNECTION,
  FIRST,
  HANDLE,
  LAST,
} = require('RelayConnectionConstants');
const {
  CURSOR,
  EDGES,
  END_CURSOR,
  HAS_NEXT_PAGE,
  HAS_PREV_PAGE,
  NODE,
  PAGE_INFO,
  START_CURSOR,
} = require('RelayConnectionInterface');

import type {
  Fragment,
  InlineFragment,
  LinkedField,
  Root,
} from 'RelayIR';
import type {GraphQLSchema, GraphQLType} from 'graphql';

const {
  assertCompositeType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLUnionType,
} = GraphQL;

type Options = {
  definitionName: ?string,
  generateRequisiteFields: boolean,
};

/**
 * @public
 *
 * Transforms fields with the `@connection` directive:
 * - Verifies that the field type is connection-like.
 * - Adds a `handle` property to the field, either the user-provided `handle`
 *   argument or the default value "connection".
 * - When the `generateRequisiteFields` option is set to true, inserts a
 *   sub-fragment on the field to ensure that standard connection fields are
 *   fetched (e.g. cursors, node ids, page info).
 */
function transform(
  context: RelayCompilerContext,
  options?: ?{generateRequisiteFields: boolean}
): RelayCompilerContext {
  const generateRequisiteFields = !!(options && options.generateRequisiteFields);
  return RelayIRTransformer.transform(
    context,
    {
      Fragment: visitFragmentOrRoot,
      LinkedField: visitLinkedField,
      Root: visitFragmentOrRoot,
    },
    () => ({
      definitionName: null,
      generateRequisiteFields,
    })
  );
}

/**
 * @public
 *
 * Extend the original schema with support for the `@connection` directive.
 */
function transformSchema(schema: GraphQLSchema): GraphQLSchema {
  const exportSchema = RelaySchemaUtils.parseSchema(`
    # TODO: replace this when extendSchema supports directives
    schema {
      query: QueryType
      mutation: MutationType
    }
    type QueryType {
      id: ID
    }
    type MutationType {
      id: ID
    }
    # The actual directive to add
    directive @connection(handle: String) on FIELD
  `);
  return RelaySchemaUtils.schemaWithDirectives(
    schema,
    exportSchema.getDirectives().filter(directive => directive.name === CONNECTION)
  );
}

/**
 * @internal
 */
function visitFragmentOrRoot<N: Fragment | Root>(node: N, options: Options): ?N {
  return this.traverse(node, {
    ...options,
    definitionName: node.name,
  });
}

/**
 * @internal
 */
function visitLinkedField(
  field: LinkedField,
  options: Options
): LinkedField {
  let transformedField = this.traverse(field, options);
  const connectionDirective = field.directives.find(directive => directive.name === CONNECTION);
  if (!connectionDirective) {
    return transformedField;
  }
  const {definitionName} = options;
  invariant(
    definitionName,
    'RelayConnectionTransform: Transform error, expected a name to have ' +
    'been set by the parent operation or fragment definition.'
  );
  validateConnectionSelection(definitionName, transformedField);
  validateConnectionType(definitionName, transformedField.type);

  let {handle} = getRelayLiteralArgumentValues(connectionDirective.args);
  invariant(
    typeof handle === 'string' || handle === undefined,
    'RelayConnectionTransform: Expected the %s argument to @%s to ' +
    'be a string literal or not specified.',
    HANDLE,
    CONNECTION
  );
  handle = handle || CONNECTION;

  if (options.generateRequisiteFields) {
    const fragment = generateConnectionFragment(
      this.getContext(),
      transformedField.type
    );
    transformedField = {
      ...transformedField,
      selections: transformedField.selections.concat(fragment),
    };
  }
  return {
    ...transformedField,
    directives: transformedField.directives.filter(directive => directive.name !== CONNECTION),
    handles: transformedField.handles ?
      [...transformedField.handles, handle] :
      [handle],
  };
}

/**
 * @internal
 *
 * Generates a fragment on the given type that fetches the minimal connection
 * fields in order to merge different pagination results together at runtime.
 */
function generateConnectionFragment(
  context: RelayCompilerContext,
  type: GraphQLType
): InlineFragment {
  const compositeType = assertCompositeType(type);
  const {nodes} = context.parse(`
    fragment ConnectionFragment on ${String(compositeType)} {
      ${EDGES} {
        ${CURSOR}
        ${NODE} {
          __typename # rely on GenerateRequisiteFieldTransform to add "id"
        }
      }
      ${PAGE_INFO} {
        ${END_CURSOR}
        ${HAS_NEXT_PAGE}
        ${HAS_PREV_PAGE}
        ${START_CURSOR}
      }
    }
  `);
  const fragment = nodes[0];
  invariant(
    fragment && fragment.kind === 'Fragment',
    'RelayConnectionTransform: Expected a connection fragment.'
  );
  return {
    directives: [],
    kind: 'InlineFragment',
    metadata: null,
    selections: fragment.selections,
    typeCondition: compositeType,
  };
}

/**
 * @internal
 *
 * Validates that the selection is a valid connection:
 * - Specifies a first or last argument to prevent accidental, unconstrained
 *   data access.
 * - Has an `edges` selection, otherwise there is nothing to paginate.
 *
 * TODO: This implementation requires the edges field to be a direct selection
 * and not contained within an inline fragment or fragment spread. It's
 * technically possible to remove this restriction if this pattern becomes
 * common/necessary.
 */
function validateConnectionSelection(
  definitionName: string,
  field: LinkedField,
): void {
  invariant(
    field.args && field.args.some(arg => arg.name === FIRST || arg.name === LAST),
    'RelayConnectionTransform: Expected field `%s: %s` to have a %s or %s ' +
    'argument in document `%s`.',
    field.name,
    field.type,
    FIRST,
    LAST,
    definitionName,
  );
  invariant(
    field.selections.some(selection => (
      selection.kind === 'LinkedField' &&
      selection.name === EDGES
    )),
    'RelayConnectionTransform: Expected field `%s: %s` to have a %s ' +
    'selection in document `%s`.',
    field.name,
    field.type,
    EDGES,
    definitionName,
  );
}

/**
 * @internal
 *
 * Validates that the type satisfies the Connection specification:
 * - The type has an edges field, and edges have scalar `cursor` and object
 *   `node` fields.
 * - The type has a page info field which is an object with the correct
 *   subfields.
 */
function validateConnectionType(
  definitionName: string,
  type: GraphQLType,
): void {
  const typeWithFields = RelaySchemaUtils.assertTypeWithFields(type);
  const typeFields = typeWithFields.getFields();
  const edges = typeFields[EDGES];

  invariant(
    edges,
    'RelayConnectionTransform: Expected type `%s` to have an %s field in ' +
    'document `%s`.',
    type,
    EDGES,
    definitionName,
  );

  const edgesType = RelaySchemaUtils.getNullableType(edges.type);
  invariant(
    edgesType instanceof GraphQLList,
    'RelayConnectionTransform: Expected `%s` field on type `%s` to be a ' +
    'list type in document `%s`.',
    EDGES,
    type,
    definitionName,
  );
  const edgeType = RelaySchemaUtils.getNullableType(edgesType.ofType);
  invariant(
    edgeType instanceof GraphQLObjectType,
    'RelayConnectionTransform: Expected %s field on type `%s` to be a list ' +
    'of objects in document `%s`.',
    EDGES,
    type,
    definitionName,
  );
  const node = edgeType.getFields()[NODE];
  if (
    !node ||
    !(node.type instanceof GraphQLInterfaceType ||
      node.type instanceof GraphQLUnionType ||
      node.type instanceof GraphQLObjectType)
  ) {
    invariant(
      false,
      'RelayConnectionTransform: Expected type `%s` to have an %s.%s field' +
      'for which the type is an interface, object, or union in document `%s`.',
      type,
      EDGES,
      NODE,
      definitionName,
    );
  }
  const cursor = edgeType.getFields()[CURSOR];
  if (!cursor || !(cursor.type instanceof GraphQLScalarType)) {
    invariant(
      false,
      'RelayConnectionTransform: Expected type `%s` to have an ' +
      '%s.%s field for which the type is an scalar in document `%s`.',
      type,
      EDGES,
      CURSOR,
      definitionName,
    );
  }
  const pageInfo = typeFields[PAGE_INFO];
  if (!pageInfo || !(pageInfo.type instanceof GraphQLObjectType)) {
    invariant(
      false,
      'RelayConnectionTransform: Expected type `%s` to have a %s field for ' +
      'which the type is an object in document `%s`.',
      type,
      PAGE_INFO,
      definitionName,
    );
  }
  const pageInfoType = RelaySchemaUtils.assertTypeWithFields(pageInfo.type);
  [END_CURSOR, HAS_NEXT_PAGE, HAS_PREV_PAGE, START_CURSOR].forEach(fieldName => {
    const pageInfoField = pageInfoType.getFields()[fieldName];
    if (!pageInfoField || !(pageInfoField.type instanceof GraphQLScalarType)) {
      invariant(
        false,
        'RelayConnectionTransform: Expected type `%s` to have an ' +
        '%s field for which the type is an scalar in document `%s`.',
        pageInfo.type,
        fieldName,
        definitionName,
      );
    }
  });
}

module.exports = {
  CONNECTION,
  transform,
  transformSchema,
};
