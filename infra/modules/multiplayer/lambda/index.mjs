// tr-mp-router: Track Record multiplayer WebSocket router (STUB).
//
// Commit 1 (infra) ships this minimal handler so the deployed API is testable:
// $connect / $disconnect return 200, and $default echoes a structured error for
// any input. The full protocol (createRoom/joinRoom/rejoin/submitGuess/
// host:phase/... per docs/MULTIPLAYER-ARCHITECTURE.md section 6) lands in
// commit 2, which replaces this file and adds unit tests.
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

export const handler = async (event) => {
  const rc = event.requestContext || {};
  const routeKey = rc.routeKey;
  const connectionId = rc.connectionId;

  if (routeKey === '$connect' || routeKey === '$disconnect') {
    return { statusCode: 200 };
  }

  // $default: structured error echo (no protocol yet).
  try {
    const endpoint = `https://${rc.domainName}/${rc.stage}`;
    const client = new ApiGatewayManagementApiClient({ endpoint });
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ error: { code: 'not_implemented', msg: 'router stub: protocol lands in commit 2' } }),
    }));
  } catch (err) {
    console.log(JSON.stringify({ action: 'default', outcome: 'post_failed', error: String(err && err.name || err) }));
  }
  return { statusCode: 200 };
};
