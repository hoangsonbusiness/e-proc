# =============================================================================
# Route 53 — DNS for eproc.devfatstrack.cloud
# Supports: existing hosted zone OR creating a new one
# =============================================================================

# --- Create NEW Hosted Zone (only if zone_id not provided) ---
resource "aws_route53_zone" "new" {
  count   = var.route53_zone_id == "" ? 1 : 0
  name    = var.domain_name
  comment = "E-Audit Platform DNS zone"

  tags = {
    Name = "eaudit-dns-zone"
  }
}

# --- Lookup EXISTING Hosted Zone (if zone_id provided) ---
data "aws_route53_zone" "existing" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
}

# --- Local: Resolve zone ID regardless of source ---
locals {
  zone_id     = var.route53_zone_id != "" ? var.route53_zone_id : aws_route53_zone.new[0].zone_id
  zone_ns     = var.route53_zone_id != "" ? [] : aws_route53_zone.new[0].name_servers
  app_fqdn    = var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name
  is_subdomain = var.app_subdomain != ""
}

# --- A Record: Subdomain → EC2 Elastic IP ---
# e.g. eproc.devfatstrack.cloud → 13.x.x.x
resource "aws_route53_record" "app" {
  zone_id = local.zone_id
  name    = local.app_fqdn
  type    = "A"
  ttl     = 300
  records = [aws_eip.eaudit_eip.public_ip]
}

# --- A Record: Root domain → EC2 (only if NOT using subdomain) ---
resource "aws_route53_record" "root" {
  count   = local.is_subdomain ? 0 : 1
  zone_id = local.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [aws_eip.eaudit_eip.public_ip]
}

# --- A Record: www → EC2 (only if NOT using subdomain) ---
resource "aws_route53_record" "www" {
  count   = local.is_subdomain ? 0 : 1
  zone_id = local.zone_id
  name    = "www.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.eaudit_eip.public_ip]
}
