<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [bitburner](./bitburner.md) &gt; [NS](./bitburner.ns.md) &gt; [ls](./bitburner.ns.ls.md)

## NS.ls() method

Returns an array with the filenames of all files on the specified server (as strings). The returned array is sorted in alphabetic order.

<b>Signature:</b>

```typescript
ls(host: string, grep?: string): string[];
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  host | string | Host or IP of the target server. |
|  grep | string | A substring to search for in the filename. |

<b>Returns:</b>

string\[\]

Array with the filenames of all files on the specified server.

## Remarks

RAM cost: 0.2 GB
