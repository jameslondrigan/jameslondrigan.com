output "cloudfront_domain" {
  description = "CloudFront distribution domain name (verify before DNS cutover)"
  value       = aws_cloudfront_distribution.site.domain_name
}

output "distribution_id" {
  description = "CloudFront distribution ID (CI cache invalidation)"
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN (scopes CI IAM policy)"
  value       = aws_cloudfront_distribution.site.arn
}

output "site_bucket_name" {
  description = "S3 bucket name (CI sync target)"
  value       = aws_s3_bucket.site.id
}

output "site_bucket_arn" {
  description = "S3 bucket ARN (scopes CI IAM policy)"
  value       = aws_s3_bucket.site.arn
}
