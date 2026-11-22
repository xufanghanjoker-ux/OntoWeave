"""Single list of tool definitions for capability checks, execution and MCP."""
from copy import deepcopy

TEXT = {"type": "string", "minLength": 1, "maxLength": 16000}
REF = {"type": "string", "minLength": 1, "maxLength": 512}
SOURCES = {"type": "array", "items": REF, "maxItems": 20}
PAGE = {"type": "integer", "minimum": 1, "maximum": 100}
DIRECTION = {"type": "string", "enum": ["OUT", "IN", "BOTH"]}
PAGE_ARGS = dict(cursor=REF, page_size=PAGE)
SEARCH = dict(query=TEXT, source_refs=SOURCES, **PAGE_ARGS)
GRAPH = dict(direction=DIRECTION, relation=TEXT, source_refs=SOURCES, **PAGE_ARGS)

TOOLS = {
    "find_entities": ("定位实体名称或别名，返回候选短引用与类型以便区分同名对象。",
                      dict(query=TEXT, **PAGE_ARGS)),
    "search_knowledge": ("查事实、规则、属性和开放陈述，保留条件、否定和时间。可用游标续页。",
                         SEARCH),
    "get_entity_facts": ("按已发放的实体短引用读直接关联知识。可用游标续页。",
                         dict(entity_ref=REF, **GRAPH)),
    "expand_graph": ("以已发放的实体短引用为起点查实际一跳边，保留原方向。可用游标续页。",
                     dict(entity_ref=REF, **GRAPH)),
    "find_paths": ("按两个已发放的实体短引用查实际路径和逐边依据。可用游标续页。",
                    dict(from_ref=REF, to_ref=REF, max_depth={"type":"integer","minimum":1,"maximum":4}, **GRAPH)),
    "search_sources": ("查原文片段。返回命中位置的原文、来源引用和可读位置，可用游标续页。",
                       dict(SEARCH, page_size=dict(PAGE, maximum=6))),
    "read_source": ("用结果中的 source 或 next_cursor 从固定版本继续读取原文。也可指定资料标题。",
                    dict(source=REF, cursor=REF)),
}

REQUIRED = {
    "find_entities": ("query",), "search_knowledge": ("query",), "search_sources": ("query",),
    "get_entity_facts": ("entity_ref",), "expand_graph": ("entity_ref",),
    "find_paths": ("from_ref", "to_ref"), "read_source": ("source",),
}


def tool_definitions(names):
    return [
        dict(name=name, description=description,
             inputSchema=dict(type="object", properties=deepcopy(fields),
                              additionalProperties=False),
             annotations=dict(readOnlyHint=True, destructiveHint=False, openWorldHint=False))
        for name, (description, fields) in TOOLS.items() if name in names
    ]


def valid_value(schema, value):
    if schema["type"] == "array":
        return isinstance(value, list) and len(value) <= schema["maxItems"] and all(
            valid_value(schema["items"], item) for item in value)
    if schema["type"] == "integer":
        return type(value) is int and schema["minimum"] <= value <= schema["maximum"]
    if "enum" in schema:
        return value in schema["enum"]
    return isinstance(value, str) and bool(value.strip()) and len(value) <= schema["maxLength"]


def valid_arguments(name, args):
    fields = TOOLS[name][1]
    return (isinstance(args, dict)
            and all(key in fields and valid_value(fields[key], val) for key, val in args.items())
            and (set(args) == {"cursor"} if "cursor" in args else all(key in args for key in REQUIRED[name])))
