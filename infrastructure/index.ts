import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

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

    // Public Subnet (ALB + NAT)
    publicSubnets.push(new aws.ec2.Subnet(`public-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 1}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: { Name: `java-3tier-public-${az}` },
    }));

    // Private App Subnet (ECS container tasks)
    privateSubnets.push(new aws.ec2.Subnet(`private-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 10}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: { Name: `java-3tier-private-${az}` },
    }));

    // Isolated DB Subnet (RDS + Redis)
    isolatedSubnets.push(new aws.ec2.Subnet(`isolated-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${(i + 1) * 100}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: { Name: `java-3tier-isolated-${az}` },
    }));
}

// NAT Gateways Provisioning (Elastic IPs + Gateways)
const natGateways: aws.ec2.NatGateway[] = [];
const eips: aws.ec2.Eip[] = [];

// Determine NAT strategy: 1 NAT Gateway for cost-optimized, or 1 per AZ for Production HA
const natCount = costOptimized ? 1 : azs.length;

for (let i = 0; i < natCount; i++) {
    eips.push(new aws.ec2.Eip(`nat-eip-${i}`, {
        domain: "vpc",
        tags: { Name: `java-3tier-nat-eip-${i}` },
    }));

    natGateways.push(new aws.ec2.NatGateway(`nat-gw-${i}`, {
        allocationId: eips[i].id,
        subnetId: publicSubnets[i].id,
        tags: { Name: `java-3tier-nat-gw-${i}` },
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

// Private Route Tables connected to NAT Gateways
const privateRouteTables: aws.ec2.RouteTable[] = [];
for (let i = 0; i < azs.length; i++) {
    // Determine which NAT Gateway to route to based on strategy
    const natGw = costOptimized ? natGateways[0] : natGateways[i];

    const privateRt = new aws.ec2.RouteTable(`private-rt-${i}`, {
        vpcId: vpc.id,
        routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGw.id }],
        tags: { Name: `java-3tier-private-rt-${i}` },
    });
    privateRouteTables.push(privateRt);

    new aws.ec2.RouteTableAssociation(`private-rta-${i}`, {
        subnetId: privateSubnets[i].id,
        routeTableId: privateRt.id,
    });
}

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
// 3. Security & Access Control (Security Groups)
// ==========================================

// Load Balancer Security Group
const albSg = new aws.ec2.SecurityGroup("alb-sg", {
    vpcId: vpc.id,
    description: "Enable HTTP ingress to Load Balancer",
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "java-3tier-alb-sg" },
});

// ECS Container Service Security Group
const ecsSg = new aws.ec2.SecurityGroup("ecs-sg", {
    vpcId: vpc.id,
    description: "Only accept HTTP traffic from ALB",
    ingress: [{
        protocol: "tcp",
        fromPort: 8080,
        toPort: 8080,
        securityGroups: [albSg.id],
    }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "java-3tier-ecs-sg" },
});

// RDS MySQL Database Security Group
const rdsSg = new aws.ec2.SecurityGroup("rds-sg", {
    vpcId: vpc.id,
    description: "Only accept MySQL traffic from ECS Task",
    ingress: [{
        protocol: "tcp",
        fromPort: 3306,
        toPort: 3306,
        securityGroups: [ecsSg.id],
    }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "java-3tier-rds-sg" },
});

// ==========================================
// 4. Secure Secrets Management (RDS Credentials)
// ==========================================
const dbSecret = new aws.secretsmanager.Secret("db-secret", {
    kmsKeyId: kmsKey.keyId,
    description: "Credentials for Amazon RDS Multi-AZ MySQL",
    recoveryWindowInDays: 0, // Quick deletion allowed for testing stacks
});

const dbPassword = new aws.random.RandomPassword("db-pwd", {
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
// 5. Database Tier (Amazon RDS)
// ==========================================

// Subnet Group representing private isolated subnets
const dbSubnetGroup = new aws.rds.SubnetGroup("rds-subnet-grp", {
    subnetIds: isolatedSubnets.map(subnet => subnet.id),
    tags: { Name: "java-3tier-db-subnet-group" },
});

// Database Master credentials helper variables
const secretCredentials = dbSecretValue.secretString.apply(val => JSON.parse(val));

const rdsInstance = new aws.rds.Instance("db-mysql", {
    engine: "mysql",
    engineVersion: "8.0.35",
    instanceClass: costOptimized ? "db.t3.micro" : "db.t3.medium",
    allocatedStorage: 20,
    storageType: "gp3",
    dbName: "UserDB",
    username: secretCredentials.username,
    password: secretCredentials.password,
    dbSubnetGroupName: dbSubnetGroup.name,
    vpcSecurityGroupIds: [rdsSg.id],
    multiAz: !costOptimized, // Enable Multi-AZ HA in Production, disable for cost-saving Dev
    storageEncrypted: true,
    kmsKeyId: kmsKey.arn,
    skipFinalSnapshot: true,
    tags: { Name: "java-3tier-rds" },
});

// ==========================================
// 6. Application Load Balancer
// ==========================================
const alb = new aws.lb.LoadBalancer("app-alb", {
    internal: false,
    securityGroups: [albSg.id],
    subnets: publicSubnets.map(subnet => subnet.id),
    loadBalancerType: "application",
    tags: { Name: "java-3tier-alb" },
});

const albTargetGroup = new aws.lb.TargetGroup("app-tg", {
    port: 8080,
    protocol: "HTTP",
    vpcId: vpc.id,
    targetType: "ip", // Required for AWS ECS Fargate tasks
    healthCheck: {
        path: "/",
        port: "8080",
        interval: 30,
        healthyThreshold: 3,
        unhealthyThreshold: 3,
        timeout: 5,
    },
    tags: { Name: "java-3tier-alb-tg" },
});

const albListener = new aws.lb.Listener("alb-http-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: albTargetGroup.arn,
    }],
});

// ==========================================
// 7. ECS & Serverless Compute Tier
// ==========================================

// ECS Container Cluster
const ecsCluster = new aws.ecs.Cluster("app-cluster", {
    tags: { Name: "java-3tier-ecs-cluster" },
});

// ECR Docker Repository
const ecrRepository = new aws.ecr.Repository("app-ecr", {
    imageScanningConfiguration: { scanOnPush: true },
    imageTagMutability: "MUTABLE",
    forceDelete: true, // Allow rapid cleanup of images during development
    tags: { Name: "java-3tier-ecr" },
});

// IAM Roles for ECS container task execution
const ecsExecutionRole = new aws.iam.Role("ecs-exec-role", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
        }],
    }),
});

// Basic AWS ECS execution permissions (Pulling from ECR + Push logs to CloudWatch)
new aws.iam.RolePolicyAttachment("ecs-exec-policy-attach", {
    role: ecsExecutionRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// Attach custom policy to read values from AWS Secrets Manager and decrypt using KMS Key
const secretPolicy = new aws.iam.Policy("ecs-secret-policy", {
    policy: pulumi.all([dbSecret.arn, kmsKey.arn]).apply(([secretArn, keyArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue"],
                Resource: [secretArn],
            },
            {
                Effect: "Allow",
                Action: ["kms:Decrypt"],
                Resource: [keyArn],
            },
        ],
    })),
});

new aws.iam.RolePolicyAttachment("ecs-secret-policy-attach", {
    role: ecsExecutionRole.name,
    policyArn: secretPolicy.arn,
});

// IAM Role for running container application operations (Task Role)
const ecsTaskRole = new aws.iam.Role("ecs-task-role", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
        }],
    }),
});

// Cloudwatch Log Group for app outputs
const logGroup = new aws.cloudwatch.LogGroup("ecs-log-grp", {
    retentionInDays: 7,
    tags: { Name: "java-3tier-logs" },
});

// ECS Fargate Serverless Task Definition
const ecsTaskDefinition = new aws.ecs.TaskDefinition("app-task-def", {
    family: "java-webapp-task",
    cpu: "256", // 0.25 vCPU
    memory: "512", // 0.5 GB RAM
    networkMode: "awsvpc", // Required for Fargate
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsExecutionRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    containerDefinitions: pulumi.all([
        ecrRepository.repositoryUrl,
        rdsInstance.address,
        dbSecret.arn,
        logGroup.name,
        aws.getRegion().then(r => r.name),
    ]).apply(([repoUrl, dbHost, secretArn, logGrpName, region]) => JSON.stringify([{
        name: "tomcat-app",
        image: `${repoUrl}:latest`, // Standard tag, can be integrated with CI tag parameter
        cpu: 256,
        memory: 512,
        essential: true,
        portMappings: [{
            containerPort: 8080,
            hostPort: 8080,
            protocol: "tcp",
        }],
        environment: [
            { name: "DB_HOST", value: dbHost },
            { name: "DB_PORT", value: "3306" },
            { name: "DB_NAME", value: "UserDB" },
        ],
        secrets: [
            {
                name: "DB_USERNAME",
                valueFrom: `${secretArn}:username::`,
            },
            {
                name: "DB_PASSWORD",
                valueFrom: `${secretArn}:password::`,
            },
        ],
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": logGrpName,
                "awslogs-region": region,
                "awslogs-stream-prefix": "tomcat",
            },
        },
    }])),
});

// ECS Fargate Service
const ecsService = new aws.ecs.Service("app-service", {
    cluster: ecsCluster.arn,
    taskDefinition: ecsTaskDefinition.arn,
    launchType: "FARGATE",
    desiredCount: costOptimized ? 1 : 2, // Enable task level HA in production
    networkConfiguration: {
        subnets: privateSubnets.map(subnet => subnet.id),
        securityGroups: [ecsSg.id],
        assignPublicIp: false, // Security: Fargate runs strictly in Private Subnets (routes through NAT)
    },
    loadBalancers: [{
        targetGroupArn: albTargetGroup.arn,
        containerName: "tomcat-app",
        containerPort: 8080,
    }],
    dependsOn: [albListener], // Ensure Target Group routes are stable before starting
    tags: { Name: "java-3tier-service" },
});

// ==========================================
// 8. Output Stack Exports
// ==========================================
export const vpcId = vpc.id;
export const ecrRepositoryUrl = ecrRepository.repositoryUrl;
export const rdsEndpoint = rdsInstance.address;
export const albDnsName = alb.dnsName;
export const webApplicationUrl = pulumi.interpolate`http://${alb.dnsName}/`;
