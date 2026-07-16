# GitHub Actions OIDC — no long-lived access keys.
#
# If the OIDC provider already exists in this account (created by another project),
# import it before applying:
#   cd infra
#   terraform import module.ci.aws_iam_openid_connect_provider.github \
#     arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

# ── Trust policy ─────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "github_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Pinned to refs/heads/main on this exact repo.
    # Feature branches and forks cannot assume this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_org}/${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "jameslondrigan-site-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
}

# ── Least-privilege deploy policy ────────────────────────────────────────────

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "S3Objects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.site_bucket_arn}/*"]
  }

  statement {
    sid       = "S3List"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.site_bucket_arn]
  }

  statement {
    sid       = "CloudFrontInvalidate"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [var.distribution_arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-policy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# ── Infra plan-only role (read-only) ─────────────────────────────────────────
# Lets the infra-plan workflow run `terraform plan` for review. Read-only
# (ReadOnlyAccess); it can never apply. Trust is pinned to refs/heads/main on
# this repo exactly like the deploy role, deliberately NOT expanded to pull_request,
# so the existing OIDC posture is unchanged. Applies stay manual (admin creds).

resource "aws_iam_role" "infra_plan" {
  name               = "jameslondrigan-infra-plan"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
}

resource "aws_iam_role_policy_attachment" "infra_plan_readonly" {
  role       = aws_iam_role.infra_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
