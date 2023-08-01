import boto3

cluster_name = "CdkFargatePocStack-ClusterEB0386A7-j2Loe8eR1Y70"
hosted_zone_id = '123456789000000000000'
record_name = 'alfa.example.com'  

def get_ip(cluster_name):
    ecs = boto3.client('ecs')

    response = ecs.list_tasks(cluster=cluster_name, desiredStatus='RUNNING')
    task_arns = response['taskArns']
    tasks_detail = ecs.describe_tasks(cluster=cluster_name, tasks=task_arns)

    public_ips = []
    for task in tasks_detail.get("tasks", []):
        for attachment in task.get("attachments", []):
            for detail in attachment.get("details", []):
                if detail.get("name") == "networkInterfaceId":
                    eni = detail.get("value")
                    eni_resource = boto3.resource("ec2").NetworkInterface(eni)
                    public_ip = eni_resource.association_attribute.get("PublicIp")
                    if public_ip:
                        public_ips.append(public_ip)

    return public_ips

def update_record(zone_id, record_name, new_ip_address):
    try:
        client = boto3.client('route53')

        response = client.list_resource_record_sets(
            HostedZoneId=zone_id,
            StartRecordName=record_name,
            StartRecordType='A',
            MaxItems='1'
        )

        if 'ResourceRecordSets' in response:
            record_set = response['ResourceRecordSets'][0]
            old_ip_address = record_set['ResourceRecords'][0]['Value']
            if new_ip_address != old_ip_address:
                record_set['ResourceRecords'][0]['Value'] = new_ip_address

                response = client.change_resource_record_sets(
                    HostedZoneId=zone_id,
                    ChangeBatch={
                        'Changes': [
                            {
                                'Action': 'UPSERT',
                                'ResourceRecordSet': record_set
                            }
                        ]
                    }
                )
                print("A record updated successfully.")
            else:
                print("The new IP address is the same as the current IP address. No update needed.")
        else:
            print("No A record found for the given zone and record name.")

    except Exception as e:
        print("An error occurred:", e)

def lambda_handler(event, context):
    public_ips = get_ip(cluster_name)
    update_record(hosted_zone_id, record_name, public_ips[0])
