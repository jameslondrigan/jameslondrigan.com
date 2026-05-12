output "cloudfront_domain" {
  description = "CloudFront distribution domain — verify here before DNS cutover"
  value       = module.static_site.cloudfront_domain
}

output "site_bucket_name" {
  description = "S3 bucket name for site assets (used by CI sync)"
  value       = module.static_site.site_bucket_name
}

output "distribution_id" {
  description = "CloudFront distribution ID (used by CI for cache invalidation)"
  value       = module.static_site.distribution_id
}

output "deploy_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC assume-role"
  value       = module.ci.deploy_role_arn
}
