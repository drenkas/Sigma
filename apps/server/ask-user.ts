import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AskQuestion } from "../../packages/contracts/index.js";

export const ASK_USER_TOOL="ask_user";
const MAX_OPTIONS=6;

/** The agent's question and its suggested answers, or undefined when the call arguments are not a usable question. */
export function askQuestion(args:any):AskQuestion|undefined{
  if(!args||typeof args!=="object"||typeof args.question!=="string"||!Array.isArray(args.options))return;
  const question=args.question.trim().slice(0,2000);
  const options=args.options.flatMap((option:any)=>{
    const label=typeof option==="string"?option.trim():typeof option?.label==="string"?option.label.trim():"";
    if(!label)return [];
    const description=typeof option?.description==="string"?option.description.trim().slice(0,400):"";
    return [{label:label.slice(0,200),...(description?{description}:{})}];
  }).slice(0,MAX_OPTIONS);
  return question&&options.length?{question,options}:undefined;
}

/** Shows a question with suggested answers above the composer and ends the turn; the user's pick or own words arrive as the next message. */
export function askUserTool(){
  return defineTool({
    name:ASK_USER_TOOL,label:"Ask the user",
    description:`Ask the user one question with 2-${MAX_OPTIONS} suggested answers when you need their decision or a missing detail before you can continue (a choice between approaches, a scope, a name). Sigma shows the question and the options above the message box; the user picks one or writes their own answer. Keep the question short and each option label a few words, with an optional one-line description. Do not repeat the question or the options in your reply text. This call ends your turn: the user's answer arrives as their next message. Do not use it for yes/no confirmations of tool actions; those have their own approvals.`,
    parameters:Type.Object({
      question:Type.String({minLength:1,maxLength:2000}),
      options:Type.Array(Type.Object({label:Type.String({minLength:1,maxLength:200}),description:Type.Optional(Type.String({maxLength:400}))}),{minItems:2,maxItems:MAX_OPTIONS}),
    }),
    execute:async(_toolCallId,params)=>{
      const question=askQuestion(params);
      if(!question)throw new Error("Question needs text and at least one option");
      return {content:[{type:"text",text:"The question and options are shown to the user. Stop here; their answer arrives as the next user message."}],details:{question},terminate:true};
    },
  });
}
