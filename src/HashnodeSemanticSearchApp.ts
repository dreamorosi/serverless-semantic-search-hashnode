import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { HashnodeSemanticSearchAuthStack } from "./HashnodeSemanticSearchAuthStack";
import { HashnodeSemanticSearchApiStack } from "./HashnodeSemanticSearchApiStack";

const app = new App();
const hashnodeSemanticSearchAuthStack = new HashnodeSemanticSearchAuthStack(
	app,
	"HashnodeSemanticSearchAuthStack",
	{
		env: {
			region: "us-east-1",
		},
	},
);
const hashnodeSemanticSearchApiStack = new HashnodeSemanticSearchApiStack(
	app,
	"HashnodeSemanticSearchApiStack",
	{},
);
hashnodeSemanticSearchApiStack.addDependency(hashnodeSemanticSearchAuthStack);
