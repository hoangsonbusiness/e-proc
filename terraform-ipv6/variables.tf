# =============================================================================
# Variables — IPv6 Optimized Environment
# =============================================================================

# --- AWS ---
variable "aws_region" {
  description = "AWS region to deploy"
  type        = string
  default     = "ap-southeast-1"
}

# --- Domain ---
variable "domain_name" {
  description = "Root domain name"
  type        = string
  default     = "devfasttrack.cloud"
}

variable "app_subdomain" {
  description = "Subdomain for the app (e.g. 'epoc' → epoc.devfasttrack.cloud)"
  type        = string
  default     = "epoc"
}

# --- EC2 ---
variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "allowed_ssh_ipv6_cidr" {
  description = "IPv6 CIDR block allowed for SSH access. Default allows all IPv6. For security, restrict to your IPv6 address, e.g. '2001:db8::/32'."
  type        = string
  default     = "::/0"
}

# --- RDS Database ---
variable "db_instance_class" {
  description = "RDS instance class (Free Tier: db.t3.micro)"
  type        = string
  default     = "db.t3.micro"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "eaudit"
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  default     = "eaudit_admin"
}

variable "db_password" {
  description = "PostgreSQL master password (min 8 chars)"
  type        = string
  sensitive   = true
}

variable "ssh_password" {
  description = "Password for the ubuntu user (used for EC2 Serial Console login)"
  type        = string
  sensitive   = true
  default     = "\
  " # Default password, change in terraform.tfvars
}

# --- App Secrets ---
variable "gemini_api_key" {
  description = "Google Gemini API key for AI grading"
  type        = string
  sensitive   = true
  default     = ""
}

variable "session_secret" {
  description = "Express session secret"
  type        = string
  sensitive   = true
  default     = "eaudit-session-secret-change-me-ipv6"
}

# --- App Config ---
variable "node_env" {
  description = "Node.js environment"
  type        = string
  default     = "production"
}

variable "app_port" {
  description = "Application port"
  type        = number
  default     = 3001
}
