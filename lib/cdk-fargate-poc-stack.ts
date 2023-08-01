import * as cdk from "aws-cdk-lib";
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { InterfaceVpcEndpointAwsService, Vpc } from "aws-cdk-lib/aws-ec2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerImage } from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { EventBus } from "aws-cdk-lib/aws-events";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as _lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import path = require("path");

export class CdkFargatePocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "PocVPC", {
      availabilityZones: ["us-east-1a", "us-east-1b"],
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "fargate-public-subnet",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const cluster = new Cluster(this, "Cluster", {
      vpc: vpc,
    });

    const fargateDefinition = new ecs.FargateTaskDefinition(
      this,
      "FargateTaskDefinition",
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
      }
    );

    fargateDefinition.addContainer("nginx", {
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
    });

    const fargateSG = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: vpc,
      allowAllOutbound: true,
    });

    fargateSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow inbound HTTP traffic"
    );

    const fargate = new ecs.FargateService(this, "FargateService", {
      cluster: cluster,
      taskDefinition: fargateDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [fargateSG],
    });

    const ruleToRefreshAddress = new events.Rule(this, "RuleToRefreshAddress", {
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          lastStatus: ["RUNNING"],
          desiredStatus: ["RUNNING"],
        },
      },
    });

    const refresherLambdaRole = new iam.Role(this, "RefresherIPLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: "RefresherLambdaRole",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
    });

    const counterLambdaRole = new iam.Role(this, "CounterLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: "CounterLambdaRole",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
    });

    const handlerLambdaRole = new iam.Role(this, "HandlerLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: "HandlerLambdaRole",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
    });

    const refresher = new _lambda.Function(this, "RefresherLambda", {
      runtime: _lambda.Runtime.PYTHON_3_9,
      code: _lambda.Code.fromAsset(path.join(__dirname, "../compute")),
      handler: "refresher.lambda_handler",
      role: refresherLambdaRole,
      timeout: cdk.Duration.seconds(30),
    });

    ruleToRefreshAddress.addTarget(new targets.LambdaFunction(refresher));

    const counter = new cloudfront.experimental.EdgeFunction(
      this,
      "DesiredCounterLambda",
      {
        runtime: _lambda.Runtime.PYTHON_3_9,
        code: _lambda.Code.fromAsset(path.join(__dirname, "../compute")),
        handler: "counter.lambda_handler",
        role: counterLambdaRole,
      }
    );

    const handler = new cloudfront.experimental.EdgeFunction(
      this,
      "ErrorHandlerLambda",
      {
        runtime: _lambda.Runtime.PYTHON_3_9,
        code: _lambda.Code.fromAsset(path.join(__dirname, "../compute")),
        handler: "handler.lambda_handler",
        role: handlerLambdaRole,
      }
    );

    const httpOriginProps: origins.HttpOriginProps = {
      httpPort: 80,
      originShieldEnabled: false,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    };

    const distribution = new cloudfront.Distribution(this, "POCDistribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin("alfa.example.com", httpOriginProps),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        edgeLambdas: [
          {
            functionVersion: counter.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
            includeBody: true,
          },
          {
            functionVersion: handler.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
          },
        ],
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    counter.addPermission("CounterPermission", {
      principal: new iam.ServicePrincipal("edgelambda.amazonaws.com"),
      action: "lambda:GetFunction",
    });

    handler.addPermission("HandlerPermission", {
      principal: new iam.ServicePrincipal("edgelambda.amazonaws.com"),
      action: "lambda:GetFunction",
    });

    const cloudFrontActivity = new cloudwatch.Alarm(
      this,
      "CloudFrontHitActivity",
      {
        metric: new cloudwatch.Metric({
          namespace: "AWS/CloudFront",
          statistic: "Sum",
          metricName: "Requests",
          dimensionsMap: {
            DistributionId: distribution.distributionId,
            Region: "Global",
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        alarmDescription:
          "Alarm if the SUM of requests to cloudfront distribution is equal to 0 for period of 5 minutes",
        datapointsToAlarm: 1,
        actionsEnabled: true,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }
    );

    const snsTopic = new sns.Topic(this, "CloudFrontHitAlarmTopic", {
      topicName: "CloudFrontHitAlarmTopic",
    });

    cloudFrontActivity.addAlarmAction(new cw_actions.SnsAction(snsTopic));

    const destroyerLambdaRole = new iam.Role(this, "ScaleDownLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      roleName: "ScaleDownLambdaRole",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
    });

    const destroyer = new _lambda.Function(this, "DestroyerLambda", {
      runtime: _lambda.Runtime.PYTHON_3_9,
      code: _lambda.Code.fromAsset(path.join(__dirname, "../compute")),
      handler: "destroyer.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      role: destroyerLambdaRole,
    });

    snsTopic.grantPublish(new AnyPrincipal());

    snsTopic.addSubscription(new subscriptions.LambdaSubscription(destroyer));
  }
}
