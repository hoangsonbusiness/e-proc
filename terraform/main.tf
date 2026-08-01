# =============================================================================
# E-Audit Platform — Terraform Configuration
# Architecture: EC2 (App) + Supabase (DB) + Route53 (DNS)
# Domain: devfatstrack.cloud
# Budget: ~$9.49/month (after Free Tier)
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }

  # Optional: Store state in S3 (uncomment for team usage)
  # backend "s3" {
  #   bucket = "eaudit-terraform-state"
  #   key    = "prod/terraform.tfstate"
  #   region = "ap-southeast-1"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "e-audit"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
