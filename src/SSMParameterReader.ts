import { Arn, Stack } from "aws-cdk-lib";
import {
	AwsCustomResource,
	AwsCustomResourcePolicy,
	PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

interface SSMParameterReaderProps {
	parameterName: string;
	region: string;
}

function removeLeadingSlash(value: string): string {
	return value.slice(0, 1) === "/" ? value.slice(1) : value;
}

export class SSMParameterReader extends AwsCustomResource {
	constructor(scope: Construct, name: string, props: SSMParameterReaderProps) {
		const { parameterName, region } = props;

		super(scope, name, {
			onUpdate: {
				service: "SSM",
				action: "getParameter",
				parameters: {
					Name: parameterName,
				},
				region,
				physicalResourceId: PhysicalResourceId.of(Date.now().toString()),
			},
			policy: AwsCustomResourcePolicy.fromSdkCalls({
				resources: [
					Arn.format(
						{
							service: "ssm",
							region: props.region,
							resource: "parameter",
							resourceName: removeLeadingSlash(parameterName),
						},
						Stack.of(scope),
					),
				],
			}),
		});
	}

	public getParameterValue(): string {
		return this.getResponseField("Parameter.Value").toString();
	}
}
