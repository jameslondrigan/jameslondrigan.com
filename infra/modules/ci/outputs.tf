output "deploy_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC assume-role"
  value       = aws_iam_role.deploy.arn
}
