# 查询迁移兼容代码的来源与许可

`crates/lightog-core/src/native_query_math_v1.rs` 按冻结 Node/V8 的正整数词频对数行为适配。原实现来源：[V8 12.4.254.21 ieee754.cc](https://github.com/v8/v8/blob/12.4.254.21/src/base/ieee754.cc)，相关 V8 源码版权为 Copyright 2016 the V8 project authors，适用 [V8 LICENSE](https://github.com/v8/v8/blob/12.4.254.21/LICENSE) 的 BSD 条款。该许可的版权、条件及免责声明保留在 [V8-LICENSE.txt](V8-LICENSE.txt)。

fdlibm 的 Sun 许可同时保留在数学源码中：

```text
Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
Developed at SunSoft, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this software is freely
granted, provided that this notice is preserved.
```

向量范数计算顺序参考冻结 V8 的 [math.tq](https://github.com/v8/v8/blob/12.4.254.21/src/builtins/math.tq)，Copyright 2019 the V8 project authors，同样适用上述 BSD 条款。

`native_query_unicode_v1.rs` 是由原 Node 环境的 Unicode 属性和 scalar lowercase API 生成的兼容数据；生成脚本、Node/V8/ICU/Unicode 版本和数据源码一并保留。现有 Rust 依赖及其许可继续由 Cargo manifests/lock 定义。本文件描述来源，不表示 V8、Google、Sun 或其贡献者对 LightOG 的背书。
