# =============================================================================
# Outputs
# =============================================================================

output "ec2_public_ip" {
  description = "EC2 Elastic IP address"
  value       = aws_eip.eaudit_eip.public_ip
}

output "ec2_instance_id" {
  description = "EC2 Instance ID"
  value       = aws_instance.eaudit.id
}

output "ssh_command" {
  description = "SSH command to access EC2"
  value       = "ssh -i eaudit-key.pem ubuntu@${aws_eip.eaudit_eip.public_ip}"
}

output "app_url" {
  description = "Application URL"
  value       = "https://${local.app_fqdn}"
}

output "app_fqdn" {
  description = "Full domain name of the application"
  value       = local.app_fqdn
}

# --- Route 53 ---
output "route53_nameservers" {
  description = "Route 53 nameservers (only if new zone was created)"
  value       = local.zone_ns
}

output "route53_zone_id" {
  description = "Route 53 Hosted Zone ID"
  value       = local.zone_id
}

# --- RDS ---
output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)"
  value       = aws_db_instance.eaudit.endpoint
}

output "database_url" {
  description = "Full DATABASE_URL for the application"
  value       = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.eaudit.endpoint}/${var.db_name}"
  sensitive   = true
}

# --- S3 ---
output "s3_backup_bucket" {
  description = "S3 bucket name for database backups"
  value       = aws_s3_bucket.backup.id
}

# --- Cost ---
output "monthly_cost_estimate" {
  description = "Estimated monthly cost"
  value       = <<-EOT
    ┌──────────────────────────────────────────────────┐
    │ Monthly Cost Estimate (Free Tier Account)        │
    ├──────────────────────┬───────────┬───────────────┤
    │ Service              │ Year 1    │ After Year 1  │
    ├──────────────────────┼───────────┼───────────────┤
    │ EC2 t3.micro         │ $0.00     │ $8.35         │
    │ RDS db.t3.micro      │ $0.00     │ $12.41        │
    │ EBS 8GB gp3          │ $0.00     │ $0.64         │
    │ RDS Storage 20GB     │ $0.00     │ $1.60         │
    │ Route 53             │ $0.50     │ $0.50         │
    │ S3 Backup            │ $0.00     │ $0.02         │
    ├──────────────────────┼───────────┼───────────────┤
    │ TOTAL                │ ~$0.50    │ ~$23.52       │
    └──────────────────────┴───────────┴───────────────┘
    App: https://${local.app_fqdn}
  EOT
}
