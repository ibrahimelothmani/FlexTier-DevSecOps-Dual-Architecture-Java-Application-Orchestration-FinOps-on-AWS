import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";

// Load Stack Configurations
const config = new pulumi.Config();
const costOptimized = config.getBoolean("costOptimized") ?? true; // Default to budget-friendly dev layout

// ==========================================
// 1. Networking Tier (VPC Setup)
// ==========================================
const vpc = new aws.ec2.Vpc("app-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { Name: "java-3tier-vpc" },
});

const internetGateway = new aws.ec2.InternetGateway("app-igw", {
    vpcId: vpc.id,
    tags: { Name: "java-3tier-igw" },
});

// Availability Zones list for deployment
const azs = ["us-east-1a", "us-east-1b"];

// Subnets Containers
const publicSubnets: aws.ec2.Subnet[] = [];
const privateSubnets: aws.ec2.Subnet[] = [];
const isolatedSubnets: aws.ec2.Subnet[] = [];

// Create Subnets across two AZs for High Availability
for (let i = 0; i < azs.length; i++) {
    const az = azs[i];

    // Public Subnet (EC2 instance + Gateway route)
    publicSubnets.push(new aws.ec2.Subnet(`public-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 1}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: { Name: `java-3tier-public-${az}` },
    }));

    // Private App Subnet (Retained for future private scale-out)
    privateSubnets.push(new aws.ec2.Subnet(`private-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 10}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: { Name: `java-3tier-private-${az}` },
    }));

    // Isolated DB Subnet (RDS MySQL)
    isolatedSubnets.push(new aws.ec2.Subnet(`isolated-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${(i + 1) * 100}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: { Name: `java-3tier-isolated-${az}` },
    }));
}

// Route Tables
const publicRouteTable = new aws.ec2.RouteTable("public-rt", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }],
    tags: { Name: "java-3tier-public-rt" },
});

// Connect Public Subnets to Route Table
publicSubnets.forEach((subnet, idx) => {
    new aws.ec2.RouteTableAssociation(`public-rta-${idx}`, {
        subnetId: subnet.id,
        routeTableId: publicRouteTable.id,
    });
});

// ==========================================
// 2. Encryption & Key Management (KMS)
// ==========================================
const kmsKey = new aws.kms.Key("java-3tier-key", {
    description: "KMS Customer Managed Key for RDS & secrets encryption",
    enableKeyRotation: true,
    deletionWindowInDays: 7,
    tags: { Name: "java-3tier-kms-key" },
});

// ==========================================
// 3. Dynamic SSH Key Generation (For Ansible)
// ==========================================
const sshPrivateKey = new tls.PrivateKey("ansible-ssh-key", {
    algorithm: "RSA",
    rsaBits: 4096,
});

const keyPair = new aws.ec2.KeyPair("ansible-keypair", {
    publicKey: sshPrivateKey.publicKeyOpenssh,
    tags: { Name: "k3s-ansible-keypair" },
});

// ==========================================
// 4. Security Groups & Firewall Settings
// ==========================================

// K3s EC2 Compute Host Security Group
const ec2Sg = new aws.ec2.SecurityGroup("k3s-ec2-sg", {
    vpcId: vpc.id,
    description: "Enable SSH, HTTP, HTTPS, and K8s API ingress to EC2 host",
    ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }, // SSH for Ansible
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }, // HTTP App Traffic
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }, // HTTPS Secure App Traffic
        { protocol: "tcp", fromPort: 6443, toPort: 6443, cidrBlocks: ["0.0.0.0/0"] }, // K3s API Server (GitHub runner connection)
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "java-3tier-k3s-ec2-sg" },
});

// RDS MySQL Database Security Group
const rdsSg = new aws.ec2.SecurityGroup("rds-sg", {
    vpcId: vpc.id,
    description: "Only accept MySQL traffic from K3s EC2 host",
    ingress: [{
        protocol: "tcp",
        fromPort: 3306,
        toPort: 3306,
        securityGroups: [ec2Sg.id], // Highly secure: Inbound database traffic only allowed from the EC2 host
    }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "java-3tier-rds-sg" },
});

// ==========================================
// 5. EC2 K3s Kubernetes Host Provisioning
// ==========================================

// Fetch the latest Ubuntu 22.04 LTS AMI dynamically
const ami = aws.ec2.getAmiOutput({
    filters: [
        { name: "name", values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"] },
        { name: "virtualization-type", values: ["hvm"] },
    ],
    mostRecent: true,
    owners: ["099720109477"], // Canonical ID for Ubuntu
});

// Provision a single-node EC2 instance to serve as our lightweight K3s cluster
const ec2Instance = new aws.ec2.Instance("k3s-host", {
    instanceType: "t3.medium", // Perfect size: 2 vCPUs, 4GB RAM to run K3s, database sidecar, and Tomcat apps easily
    ami: ami.id,
    keyName: keyPair.keyName,
    subnetId: publicSubnets[0].id,
    vpcSecurityGroupIds: [ec2Sg.id],
    associatePublicIpAddress: true,
    rootBlockDevice: {
        volumeSize: 20, // 20 GB Storage
        volumeType: "gp3",
    },
    tags: { Name: "java-3tier-k3s-host" },
});

// ==========================================
// 6. Secure Secrets Management (RDS Credentials)
// ==========================================
const dbSecret = new aws.secretsmanager.Secret("db-secret", {
    kmsKeyId: kmsKey.keyId,
    description: "Credentials for Amazon RDS Multi-AZ MySQL",
    recoveryWindowInDays: 0,
});

const dbPassword = new random.RandomPassword("db-pwd", {
    length: 16,
    special: false, // Ensure no shell-escaping issues in JDBC connections
});

// Write credentials JSON into the secret value
const dbSecretValue = new aws.secretsmanager.SecretVersion("db-secret-val", {
    secretId: dbSecret.id,
    secretString: pulumi.all([dbPassword.result]).apply(([password]) => JSON.stringify({
        username: "admin",
        password: password,
    })),
});

// ==========================================
// 7. Database Tier (Amazon RDS)
// ==========================================

// Subnet Group representing private isolated subnets
const dbSubnetGroup = new aws.rds.SubnetGroup("rds-subnet-grp", {
    subnetIds: isolatedSubnets.map(subnet => subnet.id),
    tags: { Name: "java-3tier-db-subnet-group" },
});

// Database Master credentials helper variables
const secretCredentials = dbSecretValue.secretString.apply(val => JSON.parse(val ?? "{}"));

const rdsInstance = new aws.rds.Instance("db-mysql", {
    engine: "mysql",
    engineVersion: "8.0.35",
    instanceClass: costOptimized ? "db.t3.micro" : "db.t3.medium",
    allocatedStorage: 20,
    storageType: "gp3",
    dbName: "UserDB",
    username: secretCredentials.apply(creds => creds.username),
    password: secretCredentials.apply(creds => creds.password),
    dbSubnetGroupName: dbSubnetGroup.name,
    vpcSecurityGroupIds: [rdsSg.id],
    multiAz: !costOptimized, // Multi-AZ HA in Prod, Single-AZ in costOptimized Dev
    storageEncrypted: true,
    kmsKeyId: kmsKey.arn,
    skipFinalSnapshot: true,
    tags: { Name: "java-3tier-rds" },
});

// ==========================================
// 8. ECR Container Repository (For CI/CD Image Store)
// ==========================================
const ecrRepository = new aws.ecr.Repository("app-ecr", {
    imageScanningConfiguration: { scanOnPush: true },
    imageTagMutability: "MUTABLE",
    forceDelete: true, // Allow rapid cleanup of images during development
    tags: { Name: "java-3tier-ecr" },
});

// ==========================================
// 9. Output Stack Exports
// ==========================================
export const vpcId = vpc.id;
export const ecrRepositoryUrl = ecrRepository.repositoryUrl;
export const rdsEndpoint = rdsInstance.address;
export const k3sHostPublicIp = ec2Instance.publicIp;
export const sshPrivateKeyPem = sshPrivateKey.privateKeyPem;
export const rdsPasswordValue = dbPassword.result;
export const applicationUrl = pulumi.interpolate`http://${ec2Instance.publicIp}/`;
