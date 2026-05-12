terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "jameslondrigan-tf-state-481207241421"
    key            = "jameslondrigan.com/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "jameslondrigan-tf-locks"
    encrypt        = true
  }
}
