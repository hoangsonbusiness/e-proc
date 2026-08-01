# =============================================================================
# DNS Locals (Route 53 disabled, using Cloudflare)
# =============================================================================

locals {
  app_fqdn     = var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name
  is_subdomain = var.app_subdomain != ""
  zone_ns      = []
  zone_id      = ""
}
