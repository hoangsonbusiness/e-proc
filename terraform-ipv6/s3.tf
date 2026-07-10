# =============================================================================
# S3 — Database Backup Bucket (Free Tier: 5GB)
# =============================================================================

resource "aws_s3_bucket" "backup" {
  bucket = "eaudit-db-backup-${random_id.bucket_suffix_v3.hex}"

  tags = {
    Name = "eaudit-db-backup"
  }
}

# Random suffix for globally unique bucket name
resource "random_id" "bucket_suffix_v3" {
  byte_length = 4
}

# --- Versioning ---
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id

  versioning_configuration {
    status = "Enabled"
  }
}

# --- Encryption ---
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# --- Lifecycle: Delete old backups after 30 days ---
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    id     = "cleanup-old-backups"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# --- Block Public Access ---
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket = aws_s3_bucket.backup.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
