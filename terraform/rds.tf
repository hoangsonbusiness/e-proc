# =============================================================================
# RDS — PostgreSQL 16 (db.t3.micro — Free Tier eligible)
# =============================================================================

# --- DB Subnet Group (RDS requires subnets in >= 2 AZs) ---
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "eaudit" {
  name       = "eaudit-db-subnet"
  subnet_ids = data.aws_subnets.default.ids

  tags = {
    Name = "eaudit-db-subnet-group"
  }
}

# --- RDS Security Group ---
resource "aws_security_group" "rds_sg" {
  name        = "eaudit-rds-sg"
  description = "Security group for E-Audit RDS - only EC2 can access"
  vpc_id      = data.aws_vpc.default.id

  # PostgreSQL from EC2 only
  ingress {
    description     = "PostgreSQL from EC2"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.eaudit_sg.id]
  }

  # No outbound needed for RDS
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "eaudit-rds-sg"
  }
}

# --- RDS PostgreSQL Instance ---
resource "aws_db_instance" "eaudit" {
  identifier = "eaudit-db"

  # Engine
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.db_instance_class
  parameter_group_name = "default.postgres16"

  # Storage
  allocated_storage     = 20
  max_allocated_storage = 20 # No autoscaling (control costs)
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database
  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  # Network
  db_subnet_group_name   = aws_db_subnet_group.eaudit.name
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  publicly_accessible    = false
  port                   = 5432

  # Backup (Disabled RDS-managed backups to satisfy Free Tier account limits. 
  # We already have an automated backup script daily to S3)
  backup_retention_period = 0

  # Maintenance
  maintenance_window      = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade = true

  # Performance Insights (Free Tier: 7 days retention)
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  # Monitoring
  monitoring_interval = 0 # Disable enhanced monitoring (costs extra)

  # Multi-AZ: OFF (saves cost, Free Tier only covers single-AZ)
  multi_az = false

  # Deletion
  deletion_protection = false
  skip_final_snapshot = true

  tags = {
    Name = "eaudit-postgresql"
  }

  lifecycle {
    ignore_changes = [password]
  }
}
