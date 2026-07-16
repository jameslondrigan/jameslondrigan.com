output "ws_endpoint" {
  description = "Custom-domain WebSocket endpoint for the game/controller to connect to"
  value       = "wss://${local.ws_fqdn}"
}

output "ws_default_endpoint" {
  description = "Default API Gateway WebSocket endpoint (pre-custom-domain), useful for smoke tests"
  value       = "${replace(aws_apigatewayv2_api.ws.api_endpoint, "https://", "wss://")}/${aws_apigatewayv2_stage.prod.name}"
}

output "api_id" {
  description = "WebSocket API ID"
  value       = aws_apigatewayv2_api.ws.id
}

output "rooms_table_name" {
  description = "DynamoDB rooms table name"
  value       = aws_dynamodb_table.rooms.name
}

output "router_function_name" {
  description = "Router Lambda function name"
  value       = aws_lambda_function.router.function_name
}
