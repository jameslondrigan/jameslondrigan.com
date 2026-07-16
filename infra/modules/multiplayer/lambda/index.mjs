// tr-mp-router Lambda entry point. Builds the injected `deps` from the AWS SDK
// (bundled in the nodejs20.x runtime) and delegates to route() in router.mjs.
// All protocol logic lives in router.mjs so it can be unit-tested without AWS.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { route } from './router.mjs';

const TABLE = process.env.ROOMS_TABLE;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function buildDeps(event) {
  const rc = event.requestContext || {};
  const endpoint = `https://${rc.domainName}/${rc.stage}`;
  const mgmt = new ApiGatewayManagementApiClient({ endpoint });

  return {
    table: TABLE,
    now: () => Date.now(),
    random: Math.random,

    async get(pk, sk) {
      const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
      return out.Item || null;
    },
    async put(item, opts = {}) {
      const params = { TableName: TABLE, Item: item };
      if (opts.ifNotExists) params.ConditionExpression = 'attribute_not_exists(PK) AND attribute_not_exists(SK)';
      await ddb.send(new PutCommand(params));
    },
    async update(pk, sk, changes) {
      const names = {};
      const values = {};
      const sets = [];
      let i = 0;
      for (const [k, v] of Object.entries(changes)) {
        const nk = `#k${i}`;
        const vk = `:v${i}`;
        names[nk] = k;
        values[vk] = v;
        sets.push(`${nk} = ${vk}`);
        i++;
      }
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET ' + sets.join(', '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    },
    async del(pk, sk) {
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } }));
    },
    async query(pk) {
      const out = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
      }));
      return out.Items || [];
    },
    async send(connectionId, obj) {
      await mgmt.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(obj),
      }));
    },
  };
}

export const handler = async (event) => route(event, buildDeps(event));
