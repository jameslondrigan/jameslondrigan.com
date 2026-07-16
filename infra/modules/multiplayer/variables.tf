variable "domain_name" {
  description = "Apex domain (e.g. jameslondrigan.com); the WebSocket API is served at ws.<domain_name>"
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID for the apex domain (for cert validation + the ws record)"
  type        = string
}

variable "ws_subdomain" {
  description = "Subdomain label for the WebSocket custom domain"
  type        = string
  default     = "ws"
}
