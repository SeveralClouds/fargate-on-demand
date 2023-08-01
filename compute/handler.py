def lambda_handler(event, context):
    response = event['Records'][0]['cf']['response']

    if int(response['status']) == 504:
        js_code = '''
            <script>
                function refreshPage() {
                    location.reload();
                }
                refreshPage();
            </script>
        '''
        response['status'] = 200
        response['statusDescription'] = 'OK'
        response['body'] = js_code
        response['headers']['content-type'] = [{'key': 'Content-Type', 'value': 'text/html'}]
        print("I have executed the code successfully!")
        print(response['body'])

    return response
