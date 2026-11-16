/** Strings stay whole; unsupported JSON is retained, never silently filtered away. */
import {clone,textField} from './cq-discovery-store-v2.mjs';
export function receiveFactConditions(value){
 if(value===undefined)return {conditions:null,warnings:[]};
 if(textField(value))return {conditions:[value],condition_reception:{status:'STRING_AS_ONE_CONDITION',raw:clone(value)},warnings:[]};
 if(Array.isArray(value)){const valid=value.filter(textField),invalid=value.filter(v=>!textField(v));return {conditions:valid,...(invalid.length?{condition_reception:{status:'PARTIAL_UNPARSED',raw:clone(value),unparsed:clone(invalid)}}:{}),warnings:invalid.length?['CONDITIONS_UNSUPPORTED_ITEMS_RETAINED']:[]};}
 return {conditions:null,condition_reception:{status:'UNPARSED',raw:clone(value)},warnings:['CONDITIONS_UNSUPPORTED_SHAPE_RETAINED']};
}
