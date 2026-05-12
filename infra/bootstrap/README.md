# Bootstrap

Creates the S3 bucket and DynamoDB table that the main `infra/` workspace
uses for remote state.  Run this **once** when setting up a new AWS account.
The local state it produces (`terraform.tfstate`) is committed to the repo so
the resources are never orphaned.

## Prerequisites

- Terraform >= 1.6 installed
- AWS credentials with permission to create S3 buckets and DynamoDB tables
  (`AmazonS3FullAccess` + `AmazonDynamoDBFullAccess` on a scratch user is fine;
  this is one-time setup, not CI)
- AWS region: **us-east-1**

## First-time bootstrap sequence

```sh
cd infra/bootstrap

# 1. Init (local state, no backend needed)
terraform init

# 2. Preview — confirm the bucket name includes your account ID
terraform plan

# 3. Apply — creates the S3 bucket and DynamoDB table
terraform apply

# 4. Note the outputs — you'll paste them into infra/terraform.tfvars
terraform output
```

The generated `terraform.tfstate` and `terraform.tfstate.backup` are committed
(see repo `.gitignore`).  Do **not** run `terraform destroy` here without
first migrating or deleting all state stored in the bucket.

## Re-running after an account rebuild

If the bucket and table already exist (e.g. imported from another workspace),
use `terraform import` rather than re-running apply:

```sh
terraform import aws_s3_bucket.state      <bucket-name>
terraform import aws_dynamodb_table.lock  jameslondrigan-tf-locks
```
