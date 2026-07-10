# =============================================================================
# Networking — Security Group + Elastic IP
# Uses default VPC to keep it simple and cost-free
# =============================================================================

# --- Default VPC (data source, not creating new) ---
data "aws_vpc" "default" {
  default = true
}

# --- Security Group for EC2 ---
resource "aws_security_group" "eaudit_sg" {
  name        = "eaudit-ec2-sg"
  description = "Security group for E-Audit EC2 instance"
  vpc_id      = data.aws_vpc.default.id

  # SSH
  ingress {
    description = "SSH access"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  # HTTP
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # All outbound
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "eaudit-ec2-sg"
  }
}

# --- Elastic IP ---
resource "aws_eip" "eaudit_eip" {
  domain = "vpc"

  tags = {
    Name = "eaudit-eip"
  }
}

# --- Associate EIP with EC2 ---
resource "aws_eip_association" "eaudit_eip_assoc" {
  instance_id   = aws_instance.eaudit.id
  allocation_id = aws_eip.eaudit_eip.id
}
