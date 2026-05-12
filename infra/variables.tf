variable "domain_name" {
  description = "Apex domain (e.g. jameslondrigan.com)"
  type        = string
}

variable "github_org" {
  description = "GitHub org or username that owns the repo"
  type        = string
}

variable "github_repo" {
  description = "GitHub repo name (without org prefix)"
  type        = string
}

variable "manage_dns" {
  description = "Create Route 53 A/AAAA records pointing to CloudFront. Leave false until Phase 4f DNS cutover."
  type        = bool
  default     = false
}

variable "claim_aliases" {
  description = "Add domain aliases to the CloudFront distribution. Leave false until the CRA distribution releases the CNAMEs at Phase 4f cutover."
  type        = bool
  default     = false
}
