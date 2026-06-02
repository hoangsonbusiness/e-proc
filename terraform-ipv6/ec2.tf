# =============================================================================
# EC2 Instance & IAM Roles — IPv6 Optimized
# =============================================================================

# --- Latest Ubuntu 24.04 LTS AMI ---
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# --- Generate SSH Key Pair in Memory ---
resource "tls_private_key" "eaudit_key" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

# --- Save Generated Private Key to Local PEM file ---
resource "local_file" "private_key" {
  content         = tls_private_key.eaudit_key.private_key_pem
  filename        = "${path.module}/eaudit-key.pem"
  file_permission = "0600"
}

# --- Create AWS Key Pair ---
resource "aws_key_pair" "eaudit_key" {
  key_name   = "eaudit-key-ipv6"
  public_key = tls_private_key.eaudit_key.public_key_openssh

  tags = {
    Name = "eaudit-ssh-key-ipv6"
  }
}

# --- IAM Role for EC2 ---
resource "aws_iam_role" "eaudit_ec2" {
  name = "eaudit-ec2-role-ipv6"

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
}

# --- Policy: S3 Backup Access ---
resource "aws_iam_role_policy" "s3_backup" {
  name = "eaudit-s3-backup-policy-ipv6"
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

# --- Policy Attachment: AWS Systems Manager (SSM) ---
# Allows FREE, secure shell access directly from the AWS Console browser (SSM Session Manager).
# This completely bypasses the need for public IPv4 or having an IPv6 connection at home to SSH!
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.eaudit_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# --- Instance Profile ---
resource "aws_iam_instance_profile" "eaudit_ec2" {
  name = "eaudit-ec2-profile-ipv6"
  role = aws_iam_role.eaudit_ec2.name
}

# --- EC2 Instance (IPv6-Only) ---
resource "aws_instance" "eaudit" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  key_name               = aws_key_pair.eaudit_key.key_name
  vpc_security_group_ids = [aws_security_group.eaudit_sg.id]
  iam_instance_profile   = aws_iam_instance_profile.eaudit_ec2.name

  # Allocate a public IPv6 address
  ipv6_address_count = 1

  # Disable auto-assignment of public IPv4 address to save cost
  associate_public_ip_address = false

  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/userdata.sh", {
    database_url    = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.eaudit.endpoint}/${var.db_name}"
    gemini_api_key  = var.gemini_api_key
    session_secret  = var.session_secret
    node_env        = var.node_env
    app_port        = var.app_port
    domain_name     = var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name
    www_domain_name = "" # No WWW subdomain for subdomain setups
    s3_bucket       = aws_s3_bucket.backup.id
    aws_region      = var.aws_region
    db_host         = aws_db_instance.eaudit.address
    db_port         = aws_db_instance.eaudit.port
    db_name         = var.db_name
    db_username     = var.db_username
  })

  depends_on = [aws_db_instance.eaudit]

  tags = {
    Name = "eaudit-server-ipv6"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}
