provider "aws" {
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

data "aws_route53_zone" "main" {
  name         = var.domain_name
  private_zone = false
}

# ── ACM certificate ──────────────────────────────────────────────────────────
# Lives at root (not inside a module) because CloudFront requires us-east-1
# and passing an aliased provider into a module adds boilerplate with no benefit.

resource "aws_acm_certificate" "site" {
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
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
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "site" {
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ── Modules ──────────────────────────────────────────────────────────────────

module "static_site" {
  source = "./modules/static-site"

  domain_name     = var.domain_name
  certificate_arn = aws_acm_certificate_validation.site.certificate_arn
  route53_zone_id = data.aws_route53_zone.main.zone_id
  account_id      = data.aws_caller_identity.current.account_id
  manage_dns      = var.manage_dns
  claim_aliases   = var.claim_aliases
}

module "ci" {
  source = "./modules/ci"

  github_org       = var.github_org
  github_repo      = var.github_repo
  site_bucket_arn  = module.static_site.site_bucket_arn
  distribution_arn = module.static_site.distribution_arn
}

module "multiplayer" {
  source = "./modules/multiplayer"

  domain_name     = var.domain_name
  route53_zone_id = data.aws_route53_zone.main.zone_id
}
