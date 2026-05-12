variable "domain_name" {
  description = "Apex domain (e.g. jameslondrigan.com)"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN — must be validated in us-east-1"
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID for the domain"
  type        = string
}

variable "account_id" {
  description = "AWS account ID — appended to S3 bucket name to avoid global collisions"
  type        = string
}

variable "manage_dns" {
  description = "When true, create Route 53 A/AAAA records (DNS cutover). Leave false until Phase 4f."
  type        = bool
  default     = false
}

variable "claim_aliases" {
  description = "When true, add domain aliases to the CloudFront distribution. Must be false while the existing CRA distribution still claims the same CNAMEs."
  type        = bool
  default     = false
}
