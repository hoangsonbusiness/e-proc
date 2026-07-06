Outputs:

app_fqdn = "epoc.devfatstrack.cloud"
app_url = "https://epoc.devfatstrack.cloud"
database_url = <sensitive>
ec2_instance_id = "i-045fd74dd61091dab"
ec2_public_ip = "52.74.229.94"
monthly_cost_estimate = <<EOT
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
App: https://epoc.devfatstrack.cloud

EOT
rds_endpoint = "eaudit-db.cj2qeu0i2g9c.ap-southeast-1.rds.amazonaws.com:5432"
route53_nameservers = tolist([
  "ns-1331.awsdns-38.org",
  "ns-1784.awsdns-31.co.uk",
  "ns-380.awsdns-47.com",
  "ns-628.awsdns-14.net",
])
route53_zone_id = "Z06311663NESHPU269T01"
s3_backup_bucket = "eaudit-db-backup-9fddba36"
ssh_command = "ssh -i eaudit-key.pem ubuntu@52.74.229.94"