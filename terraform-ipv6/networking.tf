# =============================================================================
# Custom VPC Configuration — Fully Optimized for IPv6
# =============================================================================

# --- Custom VPC with IPv6 Enabled ---
resource "aws_vpc" "main" {
  cidr_block                       = "10.0.0.0/16"
  assign_generated_ipv6_cidr_block = true
  enable_dns_support               = true
  enable_dns_hostnames             = true

  tags = {
    Name = "eaudit-ipv6-vpc"
  }
}

# --- Internet Gateway (for IPv6 Traffic) ---
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "eaudit-ipv6-igw"
  }
}

# --- Public Subnet (IPv6-Only for EC2) ---
resource "aws_subnet" "public" {
  vpc_id                          = aws_vpc.main.id
  cidr_block                      = "10.0.1.0/24"
  ipv6_cidr_block                 = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 1)
  availability_zone               = "${var.aws_region}a"
  
  # Crucial settings for IPv6-only setup:
  map_public_ip_on_launch         = false  # NO PUBLIC IPv4 ADDRESS! (Saves ~$3.60/month!)
  assign_ipv6_address_on_creation = true   # Auto-assigns public IPv6 addresses
  enable_dns64                    = true   # Translates IPv4-only DNS lookups to IPv6 dynamically!

  tags = {
    Name = "eaudit-ipv6-public-subnet"
  }
}

# --- Private Subnet 1 (For RDS Database - Zone A) ---
resource "aws_subnet" "private_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  ipv6_cidr_block   = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 10)
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "eaudit-private-subnet-1"
  }
}

# --- Private Subnet 2 (For RDS Database - Zone B) ---
resource "aws_subnet" "private_2" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.11.0/24"
  ipv6_cidr_block   = cidrsubnet(aws_vpc.main.ipv6_cidr_block, 8, 11)
  availability_zone = "${var.aws_region}b"

  tags = {
    Name = "eaudit-private-subnet-2"
  }
}

# --- Public Route Table (Outbound IPv6 Routing) ---
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  # Routes all public IPv6 traffic to the Internet Gateway
  route {
    ipv6_cidr_block = "::/0"
    gateway_id      = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "eaudit-ipv6-public-rt"
  }
}

# --- Associate Public Subnet with Public Route Table ---
resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# --- Security Group for EC2 (IPv6 Inbound) ---
resource "aws_security_group" "eaudit_sg" {
  name        = "eaudit-ec2-ipv6-sg"
  description = "Security group for E-Audit IPv6-only EC2 instance"
  vpc_id      = aws_vpc.main.id

  # Inbound SSH (Port 22) - IPv6 Only
  ingress {
    description      = "SSH access over IPv6"
    from_port        = 22
    to_port          = 22
    protocol         = "tcp"
    ipv6_cidr_blocks = [var.allowed_ssh_ipv6_cidr]
  }

  # Inbound HTTP (Port 80) - IPv6 Only
  ingress {
    description      = "HTTP access over IPv6"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    ipv6_cidr_blocks = ["::/0"]
  }

  # Inbound HTTPS (Port 443) - IPv6 Only
  ingress {
    description      = "HTTPS access over IPv6"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    ipv6_cidr_blocks = ["::/0"]
  }

  # Outbound Rules (Allow all IPv6 outbound, e.g. downloading dependencies)
  egress {
    description      = "All outbound IPv6"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    ipv6_cidr_blocks = ["::/0"]
  }

  # Outbound Rules (For private VPC communication)
  egress {
    description = "All outbound IPv4 (Internal VPC)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "eaudit-ec2-ipv6-sg"
  }
}
