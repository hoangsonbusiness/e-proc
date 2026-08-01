# =============================================================================
# IAM — EC2 Instance Profile for S3 Backup Access
# =============================================================================

# --- IAM Role for EC2 ---
resource "aws_iam_role" "eaudit_ec2" {
  name = "eaudit-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "eaudit-ec2-role"
  }
}

# --- Policy: S3 Backup Access ---
resource "aws_iam_role_policy" "s3_backup" {
  name = "eaudit-s3-backup-policy"
  role = aws_iam_role.eaudit_ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:DeleteObject"
        ]
        Resource = [
          aws_s3_bucket.backup.arn,
          "${aws_s3_bucket.backup.arn}/*"
        ]
      }
    ]
  })
}

# --- Policy: CloudWatch Logs (optional monitoring) ---
resource "aws_iam_role_policy" "cloudwatch" {
  name = "eaudit-cloudwatch-policy"
  role = aws_iam_role.eaudit_ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

# --- Instance Profile ---
resource "aws_iam_instance_profile" "eaudit_ec2" {
  name = "eaudit-ec2-profile"
  role = aws_iam_role.eaudit_ec2.name
}
