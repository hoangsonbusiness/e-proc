# =============================================================================
# Outputs — IPv6 Focused
# =============================================================================

output "ec2_public_ipv6" {
  description = "EC2 Public IPv6 Address"
  value       = aws_instance.eaudit.ipv6_addresses[0]
}

output "ec2_instance_id" {
  description = "EC2 Instance ID"
  value       = aws_instance.eaudit.id
}

output "app_url" {
  description = "Application URL"
  value       = "https://${var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name}"
}

# --- RDS ---
output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)"
  value       = aws_db_instance.eaudit.endpoint
}

# --- S3 ---
output "s3_backup_bucket" {
  description = "S3 bucket name for database backups"
  value       = aws_s3_bucket.backup.id
}

# --- Connectivity Advice ---
output "connectivity_guide" {
  description = "Guide on how to connect to your IPv6-only instance"
  value       = <<-EOT
    ┌────────────────────────────────────────────────────────────────────────┐
    │ E-Audit IPv6-Only Platform Deployment Successful!                      │
    ├────────────────────────────────────────────────────────────────────────┤
    │ Public IPv6 Address: ${aws_instance.eaudit.ipv6_addresses[0]}
    │ EC2 Instance ID:     ${aws_instance.eaudit.id}
    │ S3 Backup Bucket:    ${aws_s3_bucket.backup.id}
    ├────────────────────────────────────────────────────────────────────────┤
    │ How to Connect & Manage:                                               │
    │                                                                        │
    │ 1. [Free & No IPv6 Required] AWS SSM Session Manager:                   │
    │    You can open a browser terminal directly from the AWS Console.      │
    │    - Go to EC2 Console -> Select '${aws_instance.eaudit.id}'           │
    │    - Click "Connect" -> Select "Session Manager" tab -> Click "Connect"│
    │    - Or run locally: aws ssm start-session --target ${aws_instance.eaudit.id}
    │                                                                        │
    │ 2. [SSH via IPv6] (Only works if your home Internet supports IPv6):    │
    │    ssh -i eaudit-key-ipv6.pem ubuntu@${aws_instance.eaudit.ipv6_addresses[0]}
    │                                                                        │
    │ 3. Cloudflare Setup:                                                   │
    │    - Add an AAAA record pointing 'epoc' to:                            │
    │      ${aws_instance.eaudit.ipv6_addresses[0]}                          │
    │    - Enable Cloudflare SSL/TLS Proxy and set to "Full" or "Full(strict)"│
    └────────────────────────────────────────────────────────────────────────┘
  EOT
}
