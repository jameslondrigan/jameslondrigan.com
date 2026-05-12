variable "github_org" {
  description = "GitHub org or username"
  type        = string
}

variable "github_repo" {
  description = "GitHub repo name (without org prefix)"
  type        = string
}

variable "site_bucket_arn" {
  description = "ARN of the site S3 bucket — scopes s3:PutObject, s3:DeleteObject, s3:ListBucket"
  type        = string
}

variable "distribution_arn" {
  description = "ARN of the CloudFront distribution — scopes cloudfront:CreateInvalidation"
  type        = string
}
