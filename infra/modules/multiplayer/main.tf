locals {
  ws_fqdn = "${var.ws_subdomain}.${var.domain_name}"
}

# ── DynamoDB: single-table room registry (docs section 5) ─────────────────────
# PK = ROOM#{code}, SK = META | PLAYER#{token} | GUESS#{roundNo}#{token}.
# On-demand billing (rounds to ~0 at party scale); TTL self-cleans rooms.

resource "aws_dynamodb_table" "rooms" {
  name         = "tr-rooms"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# ── Router Lambda (Node 20) ───────────────────────────────────────────────────

data "archive_file" "router" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.build/router.zip"
}

resource "aws_cloudwatch_log_group" "router" {
  name              = "/aws/lambda/tr-mp-router"
  retention_in_days = 14
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "router" {
  name               = "tr-mp-router"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# Least-privilege: logs to this function's group only, R/W this table only,
# ManageConnections on this API only. No resource wildcards beyond item/stream scope.
data "aws_iam_policy_document" "router" {
  statement {
    sid       = "Logs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.router.arn}:*"]
  }

  statement {
    sid    = "RoomsTable"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.rooms.arn]
  }

  statement {
    sid       = "ManageConnections"
    effect    = "Allow"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.ws.execution_arn}/*"]
  }
}

resource "aws_iam_role_policy" "router" {
  name   = "tr-mp-router"
  role   = aws_iam_role.router.id
  policy = data.aws_iam_policy_document.router.json
}

resource "aws_lambda_function" "router" {
  function_name    = "tr-mp-router"
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.router.output_path
  source_code_hash = data.archive_file.router.output_base64sha256
  role             = aws_iam_role.router.arn
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      ROOMS_TABLE = aws_dynamodb_table.rooms.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.router]
}

# ── API Gateway WebSocket API ─────────────────────────────────────────────────

resource "aws_apigatewayv2_api" "ws" {
  name                       = "tr-mp-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_integration" "router" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.router.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.router.id}"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.router.id}"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.router.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayWSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.router.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

resource "aws_apigatewayv2_stage" "prod" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "prod"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 50
    throttling_burst_limit = 100
  }
}

# ── Custom domain: ws.<domain_name> (regional, follows the site cert pattern) ──

resource "aws_acm_certificate" "ws" {
  domain_name       = local.ws_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "ws_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.ws.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "ws" {
  certificate_arn         = aws_acm_certificate.ws.arn
  validation_record_fqdns = [for record in aws_route53_record.ws_cert_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "ws" {
  domain_name = local.ws_fqdn

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.ws.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  domain_name = aws_apigatewayv2_domain_name.ws.id
  stage       = aws_apigatewayv2_stage.prod.id
}

resource "aws_route53_record" "ws" {
  zone_id = var.route53_zone_id
  name    = local.ws_fqdn
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# ── CloudWatch alarm on router error rate ─────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "router_errors" {
  alarm_name          = "tr-mp-router-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.router.function_name
  }
}
