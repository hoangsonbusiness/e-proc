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