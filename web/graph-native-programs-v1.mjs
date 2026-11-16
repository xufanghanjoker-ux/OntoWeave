/** Upstream Sigma renderer factories; display anatomy is local to LightOG's green palette. */
import {createNodeBorderProgram} from '@sigma/node-border';
import {createEdgeCurveProgram} from '@sigma/edge-curve';
import {EdgeRectangleProgram,EdgeArrowProgram,DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS} from 'sigma/rendering';
import {drawNativeNodeLabel,drawNativeNodeHover,drawNativeEdgeLabel,NATIVE_CANVAS_FONT,createNativeLabelLayout} from './graph-native-visuals-v1.mjs';
export {nativeNodeType,nativeEdgeType} from './graph-native-visuals-v1.mjs';

export const NativeShellProgram=createNodeBorderProgram({
 drawLabel:drawNativeNodeLabel,drawHover:drawNativeNodeHover,
 borders:[
  {size:{value:.10},color:{attribute:'ringColor'}},
  {size:{value:.07},color:{attribute:'borderColor'}},
  {size:{value:.30},color:{attribute:'shellColor'}},
  {size:{fill:true},color:{attribute:'color'}},
 ],
});
export class NativeLineProgram extends EdgeRectangleProgram{drawLabel=drawNativeEdgeLabel;}
export class NativeArrowProgram extends EdgeArrowProgram{drawLabel=drawNativeEdgeLabel;}
export const NativeCurveProgram=createEdgeCurveProgram({curvatureAttribute:'curvature',drawLabel:drawNativeEdgeLabel});
export const NativeCurveArrowProgram=createEdgeCurveProgram({curvatureAttribute:'curvature',drawLabel:drawNativeEdgeLabel,arrowHead:{...DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS,extremity:'target'}});
export function withNativeTopLayers(programs){return {...programs,...Object.fromEntries(Object.entries(programs).map(([name,program])=>[name+'Top',program]))};}

/** Normal programs first, followed by every focus program: zIndex alone cannot order batches. */
export function nativeRendererSettings(){
 return {
  nativeLabelLayout:createNativeLabelLayout(),nodeProgramClasses:{'native-shell':NativeShellProgram},defaultNodeType:'native-shell',
  edgeProgramClasses:withNativeTopLayers({'native-line':NativeLineProgram,'native-line-arrow':NativeArrowProgram,'native-curve':NativeCurveProgram,'native-curve-arrow':NativeCurveArrowProgram}),defaultEdgeType:'native-line-arrow',
  defaultDrawNodeLabel:drawNativeNodeLabel,defaultDrawNodeHover:drawNativeNodeHover,defaultDrawEdgeLabel:drawNativeEdgeLabel,
  labelFont:NATIVE_CANVAS_FONT,labelSize:11,labelWeight:'500',labelColor:{color:'#d9ecdf'},labelRenderedSizeThreshold:4,labelDensity:.8,labelGridCellSize:130,
  edgeLabelFont:NATIVE_CANVAS_FONT,edgeLabelSize:11,edgeLabelWeight:'500',edgeLabelColor:{attribute:'color',color:'#a3c2ad'},renderEdgeLabels:true,minEdgeThickness:.85,zIndex:true,
 };
}
