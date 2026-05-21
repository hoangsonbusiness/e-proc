# =============================================================================
# Variables
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
  default     = "devfatstrack.cloud"
}

variable "app_subdomain" {
  description = "Subdomain for the app (e.g. 'eproc' → eproc.devfatstrack.cloud)"
  type        = string
  default     = "eproc"
}

variable "route53_zone_id" {
  description = "Existing Route 53 Hosted Zone ID. Leave empty to create a new zone."
  type        = string
  default     = ""
}

# --- EC2 ---
variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}


variable "allowed_ssh_cidr" {
  description = "CIDR block allowed for SSH access (your IP)"
  type        = string
  default     = "0.0.0.0/0"
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
  default     = "eaudit-session-secret-change-me"
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
