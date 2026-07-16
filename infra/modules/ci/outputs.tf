output "deploy_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC assume-role"
  value       = aws_iam_role.deploy.arn
}

output "infra_plan_role_arn" {
  description = "IAM role ARN for the infra-plan (read-only) GitHub Actions workflow"
  value       = aws_iam_role.infra_plan.arn
}
