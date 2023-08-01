import json
import boto3

def lambda_handler(event, context):

    ecs = boto3.client("ecs", region_name="us-east-1")
    ecs.update_service(
        cluster='arn:aws:ecs:us-east-1:123456789012:cluster/CdkFargatePocStack-ClusterEB0386A7-j2Loe8eR1Y70',
        service='CdkFargatePocStack-FargateServiceAC2B3B85-yDFl5iA9yH13',
        desiredCount=0,
    )